// scip-proto.ts — hand-rolled protobuf wire-format reader, pinned to a subset of
// `scip.proto` (Index/Metadata/ToolInfo/Document/SymbolInformation/Occurrence/
// Relationship). Read-only: this module never encodes protobuf, only decodes it.
//
// Why hand-rolled instead of a library (`protobufjs`, etc.): leina has exactly 4
// production dependencies (see package.json) and a precedent
// (assets/sidecars/csharp/RoslynGraph/IdGen.cs.tmpl) of hand-porting small,
// stable wire formats rather than pulling in a general-purpose library. The
// proto3 wire format itself is stable — it does not change even as `scip.proto`
// gains new fields/messages, so pinning to today's field numbers is safe as
// long as unknown fields are skipped rather than rejected (see below).
//
// Streaming contract: `readScipDocuments()` reads the `.scip` file with plain
// synchronous `fs` calls in fixed-size chunks, decoding and yielding ONE
// `Document` at a time. It never materializes the whole index in memory — only
// the not-yet-consumed tail of the file plus the ONE `Document` currently being
// decoded are held at once, so peak memory stays proportional to a single
// Document even for multi-hundred-MB monorepo indexes (contrast with the
// `spawnSync(..., { maxBuffer: 256 * 1024 * 1024 })` pattern the JSON sidecars
// use — see sidecar.ts).
//
// Unknown-field policy: every decoder below only inspects the field numbers it
// recognizes; every other field (from a newer/older `scip.proto` revision, or
// simply a message we don't fully model) is still walked over by `iterFields`/
// `FileCursor.skip` — which do generic wire-type-based skipping — but its value
// is discarded. This means a schema drift NEVER throws; it just silently loses
// fidelity for the unrecognized field, exactly like the C# sidecar precedent.
//
// Reference: https://protobuf.dev/programming-guides/encoding/

import { closeSync, openSync, readSync } from "node:fs";

// ---------------------------------------------------------------------------
// Wire types (proto3)
// ---------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_32BIT = 5;

/** Decode a base-128 varint starting at `pos`. Returns [value, nextPos]. Values
 * are accumulated as plain JS numbers (safe up to 2^53) rather than bitwise
 * ops, since `<<`/`|` truncate to 32 bits in JS and our pinned schema only
 * uses varints for int32/bool/enum fields and length prefixes — never a
 * genuine 64-bit quantity. */
function readVarint(buf: Buffer, pos: number): [value: number, next: number] {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new Error("scip-proto: truncated varint");
    const b = buf[p++]!;
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new Error("scip-proto: varint too long (unsupported)");
  }
  return [result, p];
}

/** ZigZag-decode a varint-encoded sint32/sint64 value (proto3 `sintN` types).
 * Not exercised by the pinned message subset today (every int field we read
 * is a plain `int32`/`bool`/`enum`, which proto3 encodes as an unsigned
 * varint) — kept as a general wire-format primitive per the parser's
 * varint/zigzag/length-delimited decoding contract, and unit-tested directly. */
export function zigzagDecode(n: number): number {
  return (n >>> 1) ^ -(n & 1);
}

interface Field {
  num: number;
  wireType: number;
  varint(): number;
  bytes(): Buffer;
}

/** Iterate the top-level fields of an already-materialized message buffer.
 * Every field is walked (cursor advances past it) regardless of whether the
 * caller recognizes `num` — that is what makes unknown fields "skip, never
 * throw": the caller's `for` loop simply never matches an unhandled `num`. */
function* iterFields(buf: Buffer, from = 0, to = buf.length): Generator<Field> {
  let pos = from;
  while (pos < to) {
    const [tag, afterTag] = readVarint(buf, pos);
    const num = tag >>> 3;
    const wireType = tag & 0x7;
    pos = afterTag;
    if (wireType === WIRE_VARINT) {
      const [val, next] = readVarint(buf, pos);
      pos = next;
      yield {
        num,
        wireType,
        varint: () => val,
        bytes: () => {
          throw new Error(`scip-proto: field ${num} is varint, not length-delimited`);
        },
      };
    } else if (wireType === WIRE_LEN) {
      const [len, afterLen] = readVarint(buf, pos);
      const start = afterLen;
      const end = start + len;
      if (end > to) throw new Error(`scip-proto: field ${num} length-delimited payload exceeds message bounds`);
      pos = end;
      yield {
        num,
        wireType,
        varint: () => {
          throw new Error(`scip-proto: field ${num} is length-delimited, not varint`);
        },
        bytes: () => buf.subarray(start, end),
      };
    } else if (wireType === WIRE_32BIT) {
      if (pos + 4 > to) throw new Error(`scip-proto: field ${num} truncated (32-bit)`);
      pos += 4;
      yield { num, wireType, varint: () => 0, bytes: () => Buffer.alloc(0) };
    } else if (wireType === WIRE_64BIT) {
      if (pos + 8 > to) throw new Error(`scip-proto: field ${num} truncated (64-bit)`);
      pos += 8;
      yield { num, wireType, varint: () => 0, bytes: () => Buffer.alloc(0) };
    } else {
      // Wire types 3/4 (deprecated proto2 start/end group) are not emitted by
      // proto3 generators and are not part of the pinned schema; there is no
      // safe generic skip for them without group-aware bookkeeping.
      throw new Error(`scip-proto: unsupported wire type ${wireType} for field ${num}`);
    }
  }
}

/** Decode a packed-repeated varint field's payload (proto3 default packing for
 * repeated scalar numeric fields) into a plain number array. */
function decodePackedVarints(buf: Buffer): number[] {
  const out: number[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [v, next] = readVarint(buf, pos);
    out.push(v);
    pos = next;
  }
  return out;
}

const utf8 = (buf: Buffer): string => buf.toString("utf8");

// ---------------------------------------------------------------------------
// Pinned schema subset — public shapes
// ---------------------------------------------------------------------------

export interface ScipRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** `SymbolRole.Definition` bit (see scip.proto `enum SymbolRole`). */
export const SYMBOL_ROLE_DEFINITION = 0x1;

export interface ScipOccurrence {
  range: ScipRange | null;
  symbol: string;
  symbolRoles: number;
  /** Nearest non-trivial enclosing AST node range (e.g. the whole function body
   * for a function's Definition occurrence). Used to derive `calls` edges by
   * containment — see scip-indexer.ts. */
  enclosingRange: ScipRange | null;
}

export interface ScipRelationship {
  symbol: string;
  isImplementation: boolean;
  isTypeDefinition: boolean;
}

export interface ScipSymbolInformation {
  symbol: string;
  /** Raw `SymbolInformation.Kind` enum value (see scip.proto) — 0 when absent/unknown. */
  kind: number;
  displayName: string;
  relationships: ScipRelationship[];
}

export interface ScipDocument {
  relativePath: string;
  language: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
}

export interface ScipToolInfo {
  name: string;
  version: string;
}

export interface ScipMetadata {
  toolInfo: ScipToolInfo | null;
  projectRoot: string;
}

// ---------------------------------------------------------------------------
// Range decoding — proto3 packs a repeated scalar int32 field by default; this
// parser also tolerates the (rare, but legal) unpacked form for robustness.
// ---------------------------------------------------------------------------

// Occurrence.range / Occurrence.enclosing_range: 3 elements = single-line
// [line, startChar, endChar]; 4 elements = multi-line [startLine, startChar,
// endLine, endChar]. See scip.proto's `Occurrence` message doc comment.
function decodeRange(ints: number[]): ScipRange | null {
  if (ints.length === 3) {
    return { startLine: ints[0]!, startCharacter: ints[1]!, endLine: ints[0]!, endCharacter: ints[2]! };
  }
  if (ints.length === 4) {
    return { startLine: ints[0]!, startCharacter: ints[1]!, endLine: ints[2]!, endCharacter: ints[3]! };
  }
  return null; // malformed/empty — degrade to "no position info" rather than throw
}

function collectRangeInts(existing: number[], field: Field): number[] {
  if (field.wireType === WIRE_LEN) return [...existing, ...decodePackedVarints(field.bytes())];
  if (field.wireType === WIRE_VARINT) return [...existing, field.varint()];
  return existing;
}

// ---------------------------------------------------------------------------
// Message decoders — each interprets only its pinned field numbers; every
// other field is enumerated by `iterFields` (cursor advances) but ignored.
// ---------------------------------------------------------------------------

function decodeRelationship(buf: Buffer): ScipRelationship {
  let symbol = "";
  let isImplementation = false;
  let isTypeDefinition = false;
  for (const f of iterFields(buf)) {
    if (f.num === 1 && f.wireType === WIRE_LEN) symbol = utf8(f.bytes());
    else if (f.num === 3 && f.wireType === WIRE_VARINT) isImplementation = f.varint() !== 0;
    else if (f.num === 4 && f.wireType === WIRE_VARINT) isTypeDefinition = f.varint() !== 0;
  }
  return { symbol, isImplementation, isTypeDefinition };
}

function decodeOccurrence(buf: Buffer): ScipOccurrence {
  let rangeInts: number[] = [];
  let enclosingInts: number[] = [];
  let symbol = "";
  let symbolRoles = 0;
  for (const f of iterFields(buf)) {
    if (f.num === 1) rangeInts = collectRangeInts(rangeInts, f);
    else if (f.num === 2 && f.wireType === WIRE_LEN) symbol = utf8(f.bytes());
    else if (f.num === 3 && f.wireType === WIRE_VARINT) symbolRoles = f.varint();
    else if (f.num === 7) enclosingInts = collectRangeInts(enclosingInts, f);
  }
  return { range: decodeRange(rangeInts), symbol, symbolRoles, enclosingRange: decodeRange(enclosingInts) };
}

function decodeSymbolInformation(buf: Buffer): ScipSymbolInformation {
  let symbol = "";
  let kind = 0;
  let displayName = "";
  const relationships: ScipRelationship[] = [];
  for (const f of iterFields(buf)) {
    if (f.num === 1 && f.wireType === WIRE_LEN) symbol = utf8(f.bytes());
    else if (f.num === 4 && f.wireType === WIRE_LEN) relationships.push(decodeRelationship(f.bytes()));
    else if (f.num === 5 && f.wireType === WIRE_VARINT) kind = f.varint();
    else if (f.num === 6 && f.wireType === WIRE_LEN) displayName = utf8(f.bytes());
  }
  return { symbol, kind, displayName, relationships };
}

function decodeDocument(buf: Buffer): ScipDocument {
  let relativePath = "";
  let language = "";
  const occurrences: ScipOccurrence[] = [];
  const symbols: ScipSymbolInformation[] = [];
  for (const f of iterFields(buf)) {
    if (f.num === 1 && f.wireType === WIRE_LEN) relativePath = utf8(f.bytes());
    else if (f.num === 2 && f.wireType === WIRE_LEN) occurrences.push(decodeOccurrence(f.bytes()));
    else if (f.num === 3 && f.wireType === WIRE_LEN) symbols.push(decodeSymbolInformation(f.bytes()));
    else if (f.num === 4 && f.wireType === WIRE_LEN) language = utf8(f.bytes());
  }
  return { relativePath, language, occurrences, symbols };
}

function decodeToolInfo(buf: Buffer): ScipToolInfo {
  let name = "";
  let version = "";
  for (const f of iterFields(buf)) {
    if (f.num === 1 && f.wireType === WIRE_LEN) name = utf8(f.bytes());
    else if (f.num === 2 && f.wireType === WIRE_LEN) version = utf8(f.bytes());
  }
  return { name, version };
}

function decodeMetadata(buf: Buffer): ScipMetadata {
  let toolInfo: ScipToolInfo | null = null;
  let projectRoot = "";
  for (const f of iterFields(buf)) {
    if (f.num === 2 && f.wireType === WIRE_LEN) toolInfo = decodeToolInfo(f.bytes());
    else if (f.num === 3 && f.wireType === WIRE_LEN) projectRoot = utf8(f.bytes());
  }
  return { toolInfo, projectRoot };
}

// ---------------------------------------------------------------------------
// Streaming file reader — a growable buffer with an explicit read cursor.
// Reads the `.scip` file in fixed-size chunks (default 64 KiB) via synchronous
// `fs` calls, holding only the not-yet-consumed tail plus the current message's
// bytes in memory — never the whole file.
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK = 1 << 16; // 64 KiB

class FileCursor {
  private readonly fd: number;
  private buf: Buffer;
  private pos = 0; // next unread byte offset in buf
  private len = 0; // valid bytes currently in buf
  private eof = false;

  constructor(fd: number) {
    this.fd = fd;
    this.buf = Buffer.alloc(DEFAULT_CHUNK);
  }

  /** Ensure at least `n` unread bytes are buffered (fewer only at true EOF). */
  private fill(n: number): void {
    if (this.len - this.pos >= n || this.eof) return;
    // Compact: drop the already-consumed prefix so we don't grow unboundedly.
    if (this.pos > 0) {
      this.buf.copy(this.buf, 0, this.pos, this.len);
      this.len -= this.pos;
      this.pos = 0;
    }
    // Grow up front if the requested window can never fit in the current buffer.
    if (this.buf.length < n) {
      const grown = Buffer.alloc(Math.max(n, this.buf.length * 2));
      this.buf.copy(grown, 0, 0, this.len);
      this.buf = grown;
    }
    while (this.len - this.pos < n && !this.eof) {
      if (this.len === this.buf.length) {
        const grown = Buffer.alloc(this.buf.length * 2);
        this.buf.copy(grown, 0, 0, this.len);
        this.buf = grown;
      }
      const bytesRead = readSync(this.fd, this.buf, this.len, this.buf.length - this.len, null);
      if (bytesRead === 0) {
        this.eof = true;
        break;
      }
      this.len += bytesRead;
    }
  }

  atEnd(): boolean {
    this.fill(1);
    return this.len - this.pos === 0;
  }

  private readByte(): number {
    this.fill(1);
    if (this.len - this.pos < 1) throw new Error("scip-proto: unexpected end of file");
    return this.buf[this.pos++]!;
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.readByte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }

  /** Read exactly `n` bytes as a standalone copy (safe to retain across fills). */
  readBytes(n: number): Buffer {
    this.fill(n);
    if (this.len - this.pos < n) throw new Error("scip-proto: unexpected end of file (truncated message)");
    const out = Buffer.from(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return out;
  }

  skip(wireType: number): void {
    if (wireType === WIRE_VARINT) {
      this.readVarint();
      return;
    }
    if (wireType === WIRE_64BIT) {
      this.fill(8);
      this.pos += 8;
      return;
    }
    if (wireType === WIRE_LEN) {
      const len = this.readVarint();
      this.fill(len);
      this.pos += len;
      return;
    }
    if (wireType === WIRE_32BIT) {
      this.fill(4);
      this.pos += 4;
      return;
    }
    throw new Error(`scip-proto: unsupported wire type ${wireType}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stream a `.scip` (SCIP protobuf) index Document by Document. Each Document is
 * fully decoded, yielded, and then eligible for GC before the next one is read
 * — the file itself is never materialized in full, so peak memory stays
 * proportional to a single Document even for multi-hundred-MB indexes.
 *
 * Pinned to a subset of scip.proto (Index/Metadata/ToolInfo/Document/
 * SymbolInformation/Occurrence/Relationship). Any other top-level `Index`
 * field (e.g. `external_symbols`) and any unrecognized nested field is skipped
 * — never throws — so a newer indexer schema degrades gracefully.
 */
export function* readScipDocuments(path: string): Generator<ScipDocument> {
  const fd = openSync(path, "r");
  try {
    const cursor = new FileCursor(fd);
    while (!cursor.atEnd()) {
      const tag = cursor.readVarint();
      const num = tag >>> 3;
      const wireType = tag & 0x7;
      if (num === 2 && wireType === WIRE_LEN) {
        const len = cursor.readVarint();
        yield decodeDocument(cursor.readBytes(len));
      } else {
        cursor.skip(wireType);
      }
    }
  } finally {
    closeSync(fd);
  }
}

/** Read only `Index.metadata` (small — tool name/version/project root). Used to
 * sanity-check which indexer/version produced the file before trusting its
 * documents. Returns null if the index has no metadata field at all. */
export function readScipMetadata(path: string): ScipMetadata | null {
  const fd = openSync(path, "r");
  try {
    const cursor = new FileCursor(fd);
    while (!cursor.atEnd()) {
      const tag = cursor.readVarint();
      const num = tag >>> 3;
      const wireType = tag & 0x7;
      if (num === 1 && wireType === WIRE_LEN) {
        const len = cursor.readVarint();
        return decodeMetadata(cursor.readBytes(len));
      }
      cursor.skip(wireType);
    }
    return null;
  } finally {
    closeSync(fd);
  }
}
