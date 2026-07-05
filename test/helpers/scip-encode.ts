// test/helpers/scip-encode.ts — minimal protobuf ENCODER used only by tests to
// hand-craft synthetic `.scip` byte streams (unknown fields, multi-Document
// indexes, etc.) against which src/infrastructure/extractors/semantic/
// scip-proto.ts's decoder is exercised. Deliberately independent of the
// decoder's internals — it only needs to speak the same wire format.

const WIRE_VARINT = 0;
const WIRE_LEN = 2;

export function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  for (;;) {
    const b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v !== 0) {
      bytes.push(b | 0x80);
    } else {
      bytes.push(b);
      break;
    }
  }
  return Buffer.from(bytes);
}

function tag(fieldNum: number, wireType: number): Buffer {
  return encodeVarint((fieldNum << 3) | wireType);
}

export function varintField(fieldNum: number, value: number): Buffer {
  return Buffer.concat([tag(fieldNum, WIRE_VARINT), encodeVarint(value)]);
}

export function stringField(fieldNum: number, value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  return Buffer.concat([tag(fieldNum, WIRE_LEN), encodeVarint(body.length), body]);
}

export function bytesField(fieldNum: number, body: Buffer): Buffer {
  return Buffer.concat([tag(fieldNum, WIRE_LEN), encodeVarint(body.length), body]);
}

/** Packed-repeated int32 field (proto3 default packing). */
export function packedIntsField(fieldNum: number, ints: number[]): Buffer {
  const body = Buffer.concat(ints.map(encodeVarint));
  return bytesField(fieldNum, body);
}

export interface EncOccurrence {
  range: number[]; // 3 or 4 packed ints
  symbol: string;
  symbolRoles?: number;
  enclosingRange?: number[];
}

export function encodeOccurrence(occ: EncOccurrence): Buffer {
  const parts: Buffer[] = [packedIntsField(1, occ.range), stringField(2, occ.symbol)];
  if (occ.symbolRoles !== undefined) parts.push(varintField(3, occ.symbolRoles));
  if (occ.enclosingRange) parts.push(packedIntsField(7, occ.enclosingRange));
  return Buffer.concat(parts);
}

export interface EncRelationship {
  symbol: string;
  isImplementation?: boolean;
  isTypeDefinition?: boolean;
}

export function encodeRelationship(rel: EncRelationship): Buffer {
  const parts: Buffer[] = [stringField(1, rel.symbol)];
  if (rel.isImplementation) parts.push(varintField(3, 1));
  if (rel.isTypeDefinition) parts.push(varintField(4, 1));
  return Buffer.concat(parts);
}

export interface EncSymbolInformation {
  symbol: string;
  kind?: number;
  displayName?: string;
  relationships?: EncRelationship[];
}

export function encodeSymbolInformation(sym: EncSymbolInformation): Buffer {
  const parts: Buffer[] = [stringField(1, sym.symbol)];
  for (const rel of sym.relationships ?? []) parts.push(bytesField(4, encodeRelationship(rel)));
  if (sym.kind !== undefined) parts.push(varintField(5, sym.kind));
  if (sym.displayName !== undefined) parts.push(stringField(6, sym.displayName));
  return Buffer.concat(parts);
}

export interface EncDocument {
  relativePath: string;
  language?: string;
  occurrences?: EncOccurrence[];
  symbols?: EncSymbolInformation[];
}

export function encodeDocument(doc: EncDocument): Buffer {
  const parts: Buffer[] = [stringField(1, doc.relativePath)];
  for (const occ of doc.occurrences ?? []) parts.push(bytesField(2, encodeOccurrence(occ)));
  for (const sym of doc.symbols ?? []) parts.push(bytesField(3, encodeSymbolInformation(sym)));
  if (doc.language !== undefined) parts.push(stringField(4, doc.language));
  return Buffer.concat(parts);
}

/** Wrap a Document payload as `Index.documents` field (field 2, length-delimited). */
export function indexDocumentField(doc: EncDocument): Buffer {
  return bytesField(2, encodeDocument(doc));
}

/** A minimal `Index.metadata` field (field 1) with just a tool name/version. */
export function indexMetadataField(toolName: string, toolVersion: string): Buffer {
  const toolInfo = Buffer.concat([stringField(1, toolName), stringField(2, toolVersion)]);
  const metadata = bytesField(2, toolInfo);
  return bytesField(1, metadata);
}

/** An unrecognized top-level Index field (e.g. a hypothetical future field
 * number), used to prove unknown fields are skipped rather than throwing. */
export function unknownVarintField(fieldNum: number, value: number): Buffer {
  return varintField(fieldNum, value);
}

/** Wrap arbitrary already-encoded bytes as field `fieldNum` (length-delimited). */
export function wrapAsField(fieldNum: number, body: Buffer): Buffer {
  return bytesField(fieldNum, body);
}

/** A full one-Document `.scip` byte stream (metadata + one document),
 * ready to `writeFileSync` and read back with `readScipDocuments` — the
 * shape `runScipIndexer`'s guard tests need (unlike the plain
 * `ScipDocument` JS objects `scip-indexer.test.ts` builds by hand, these
 * exercise the REAL decode path too). */
export function encodeIndex(doc: EncDocument): Buffer {
  return Buffer.concat([indexMetadataField("test-tool", "0.0.0"), indexDocumentField(doc)]);
}

// ---------------------------------------------------------------------------
// Synthetic SCIP SYMBOL STRINGS (sdd/scip-lang-rollout, Ola A task A2.1) —
// hand-built per the grammar documented in scip-indexer.ts's file header,
// reusable across unit tests that exercise per-language translation logic
// (`normalizeImpl`, the `kind===0` suffix fallback, Python's nested-function
// flattening) WITHOUT needing a real rust-analyzer/scip-python binary. These
// are plain strings — no protobuf involved — matching exactly what
// `parseScipSymbol`/`translateScipSymbol` consume.
// ---------------------------------------------------------------------------

/** A minimal well-formed 4-field SCIP symbol head (`<scheme> <manager>
 * <package-name> <version>`), reusable as the prefix for any descriptor
 * chain built by the builders below. */
export function scipHead(scheme: string, manager: string, packageName: string, version: string): string {
  return `${scheme} ${manager} ${packageName} ${version}`;
}

/**
 * Rust `impl` block method symbol, matching rust-analyzer's real encoding
 * (`impl#[SelfType]method().` for an inherent impl, `impl#[SelfType][Trait]method().`
 * for a trait impl) — the shape `normalizeImpl` must rewrite. Two calls with
 * the SAME `head` but different `selfType` simulate two `impl` blocks in one
 * file (the case `normalizeImpl` must keep from colliding on a shared
 * `"impl"` owner).
 */
export function rustImplMethodSymbol(head: string, selfType: string, method: string, trait?: string): string {
  const typeParams = trait ? `[${selfType}][${trait}]` : `[${selfType}]`;
  return `${head} impl#${typeParams}${method}().`;
}

/** Rust `impl` block itself, as a bare type descriptor chain (no member) —
 * used to assert `normalizeImpl` resolves the owner id even with no method. */
export function rustImplTypeSymbol(head: string, selfType: string, trait?: string): string {
  const typeParams = trait ? `[${selfType}][${trait}]` : `[${selfType}]`;
  return `${head} impl#${typeParams}`;
}

/** Python class/struct-shaped symbol with NO `kind` (scip-python always
 * emits `kind=0`) — a bare `type` descriptor, exercising the
 * `typeFallback` branch of `fallbackKind`. */
export function pythonKind0TypeSymbol(head: string, name: string): string {
  return `${head} ${name}#`;
}

/** Python method-with-owner symbol (`kind=0`) — exercises the `method` +
 * owner-present branch of `fallbackKind` (-> `"method"`). */
export function pythonKind0MethodSymbol(head: string, owner: string, method: string): string {
  return `${head} ${owner}#${method}().`;
}

/** Python top-level function symbol (`kind=0`, no owner) — exercises the
 * `method` + no-owner branch of `fallbackKind` (-> `"function"`). */
export function pythonKind0FunctionSymbol(head: string, name: string): string {
  return `${head} ${name}().`;
}

/**
 * Python NESTED function symbol: scip-python nests a function inside its
 * lexically enclosing function as a `method` descriptor chain
 * (`outer().inner().`) — confirmed against `treeVisitor.ts`'s
 * `Symbols.makeMethod(getScipSymbol(node.parent), name)`. Two calls with the
 * SAME `outer` but different `inner` (in different closures) must still
 * flatten to the SAME id once `flattenNestedFns` drops the non-final
 * `method` descriptor, matching tree-sitter's flat id for nested functions.
 */
export function pythonNestedFunctionSymbol(head: string, outer: string, inner: string): string {
  return `${head} ${outer}().${inner}().`;
}
