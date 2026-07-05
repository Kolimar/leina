// application/audit/source-sink-catalog.ts
// Built-in catalog of source and sink patterns per language.
// CRIT-3 (FR-12): catalogVersion, per-language patterns, user JSON override.
//
// Sources: HTTP entrypoints, req.body/query/params, argv, stdin, deserializers,
//          message consumers.
// Sinks:   eval/dynamic code, child_process/exec, SQL string concat, path traversal,
//          template rendering, SSRF (outbound HTTP), weak crypto.
//
// Matching: a node is a "source" or "sink" when its normalized label matches
// a pattern label (case-insensitive substring).

import { existsSync, readFileSync } from "node:fs";
import type { GraphNode } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PatternRole = "source" | "sink";
export type SinkCategory =
  | "eval"
  | "exec"
  | "sql"
  | "path-traversal"
  | "template-render"
  | "ssrf"
  | "weak-crypto";
export type SourceCategory =
  | "http-request"
  | "env-argv"
  | "stdin"
  | "deserialize"
  | "message-consumer";

export interface SourceSinkPattern {
  id: string;
  role: PatternRole;
  category: SinkCategory | SourceCategory;
  languages: string[];   // ["*"] = all languages
  description: string;
  /** Label substrings that qualify a node (case-insensitive, any match wins). */
  labelPatterns: string[];
  /** Import module substrings (informational for override files). */
  importPatterns?: string[];
}

export interface MatchedNode {
  node: GraphNode;
  pattern: SourceSinkPattern;
  matchedOn: "label";
}

export interface SourceSinkCatalogResult {
  catalogVersion: string;
  sources: MatchedNode[];
  sinks: MatchedNode[];
}

// ---------------------------------------------------------------------------
// Built-in patterns (catalogVersion: "1.0.0")
// ---------------------------------------------------------------------------

export const CATALOG_VERSION = "1.0.0";

export const BUILT_IN_PATTERNS: SourceSinkPattern[] = [
  // ------------------------------------------------------------------
  // SOURCES — HTTP input
  // ------------------------------------------------------------------
  {
    id: "src-http-handler",
    role: "source",
    category: "http-request",
    languages: ["typescript", "javascript"],
    description: "HTTP handler / controller function that receives request data",
    labelPatterns: ["handler", "controller", "route", "endpoint", "requesthandler",
                    "onrequest", "handlerequest"],
    importPatterns: ["express", "koa", "fastify", "hapi", "@hapi/hapi"],
  },
  {
    id: "src-http-lambda",
    role: "source",
    category: "http-request",
    languages: ["typescript", "javascript"],
    description: "AWS Lambda / serverless handler receiving HTTP event",
    labelPatterns: ["lambdahandler", "apigwhandler"],
    importPatterns: ["aws-lambda", "@aws-sdk"],
  },
  // ------------------------------------------------------------------
  // SOURCES — env / argv
  // ------------------------------------------------------------------
  {
    id: "src-env-argv",
    role: "source",
    category: "env-argv",
    languages: ["*"],
    description: "Command-line arguments or environment variables",
    labelPatterns: ["parseargs", "parseargv", "getargs", "readenv", "loadenv"],
    importPatterns: ["dotenv", "yargs", "commander", "minimist"],
  },
  // ------------------------------------------------------------------
  // SOURCES — stdin / streams
  // ------------------------------------------------------------------
  {
    id: "src-stdin",
    role: "source",
    category: "stdin",
    languages: ["*"],
    description: "Standard input (stdin) or readable stream",
    labelPatterns: ["readstdin", "readinput", "parseinput", "getstdin"],
    importPatterns: ["readline", "stream"],
  },
  // ------------------------------------------------------------------
  // SOURCES — deserialization
  // ------------------------------------------------------------------
  {
    id: "src-deserialize",
    role: "source",
    category: "deserialize",
    languages: ["typescript", "javascript"],
    description: "JSON deserialization — untrusted data enters the object graph",
    labelPatterns: ["deserialize", "fromjson", "parsejson", "parseyaml",
                    "parsetoml", "parsexml"],
    importPatterns: ["js-yaml", "yaml", "@iarna/toml"],
  },
  // ------------------------------------------------------------------
  // SOURCES — message queue consumers
  // ------------------------------------------------------------------
  {
    id: "src-message-consumer",
    role: "source",
    category: "message-consumer",
    languages: ["typescript", "javascript"],
    description: "Message queue / event-bus consumer receiving untrusted data",
    labelPatterns: ["consume", "subscribe", "onmessage", "processmessage",
                    "handleevent", "receivemessage", "processevent"],
    importPatterns: ["amqplib", "kafkajs", "bull", "bullmq", "@aws-sdk/client-sqs",
                     "nats", "redis", "ioredis"],
  },
  // ------------------------------------------------------------------
  // SINKS — eval / dynamic code execution
  // ------------------------------------------------------------------
  {
    id: "sink-eval",
    role: "sink",
    category: "eval",
    languages: ["typescript", "javascript"],
    description: "eval() / new Function() — dynamic code execution",
    labelPatterns: ["evalcode", "runeval", "executeeval", "dynamiceval",
                    "safeeval", "unsafeeval"],
    importPatterns: [],
  },
  {
    id: "sink-vm-run",
    role: "sink",
    category: "eval",
    languages: ["typescript", "javascript"],
    description: "Node.js vm.runInNewContext / vm.Script — dynamic code execution",
    labelPatterns: ["runscript", "executescript", "runcode", "runinnewcontext",
                    "runincontext"],
    importPatterns: ["vm"],
  },
  // ------------------------------------------------------------------
  // SINKS — child_process / command execution
  // ------------------------------------------------------------------
  {
    id: "sink-exec",
    role: "sink",
    category: "exec",
    languages: ["typescript", "javascript"],
    description: "child_process.exec/spawn — OS command injection risk",
    labelPatterns: ["execcommand", "runcommand", "spawnprocess", "execshell",
                    "shellexec", "runshell", "executecommand"],
    importPatterns: ["child_process"],
  },
  {
    id: "sink-exec-py",
    role: "sink",
    category: "exec",
    languages: ["python"],
    description: "subprocess.run/Popen — OS command injection risk",
    labelPatterns: ["runcommand", "execshell", "callprocess", "spawnprocess"],
    importPatterns: ["subprocess", "os"],
  },
  // ------------------------------------------------------------------
  // SINKS — SQL string concatenation
  // ------------------------------------------------------------------
  {
    id: "sink-sql",
    role: "sink",
    category: "sql",
    languages: ["typescript", "javascript"],
    description: "Raw SQL query construction — SQL injection risk",
    labelPatterns: ["rawquery", "unsafequery", "buildquery", "constructsql",
                    "executesql", "runsql", "querydb"],
    importPatterns: ["pg", "mysql", "mysql2", "sqlite3", "mssql", "knex",
                     "sequelize", "typeorm"],
  },
  // ------------------------------------------------------------------
  // SINKS — path traversal
  // ------------------------------------------------------------------
  {
    id: "sink-path-traversal",
    role: "sink",
    category: "path-traversal",
    languages: ["typescript", "javascript"],
    description: "File system write with user-controlled path — traversal risk",
    labelPatterns: ["writefile", "savefile", "writepath", "savepath",
                    "appendfile", "deletefile", "removefile"],
    importPatterns: ["fs", "node:fs", "fs/promises"],
  },
  // ------------------------------------------------------------------
  // SINKS — template rendering
  // ------------------------------------------------------------------
  {
    id: "sink-template-render",
    role: "sink",
    category: "template-render",
    languages: ["typescript", "javascript"],
    description: "Template rendering with user-controlled data — XSS / SSTI risk",
    labelPatterns: ["rendertemplate", "compiletemplate", "renderview",
                    "rendershtml", "buildhtml"],
    importPatterns: ["ejs", "pug", "jade", "handlebars", "mustache", "nunjucks"],
  },
  // ------------------------------------------------------------------
  // SINKS — SSRF (outbound HTTP)
  // ------------------------------------------------------------------
  {
    id: "sink-ssrf",
    role: "sink",
    category: "ssrf",
    languages: ["typescript", "javascript"],
    description: "Outbound HTTP call with user-controlled URL — SSRF risk",
    labelPatterns: ["fetchurl", "makehttp", "sendhttprequest", "callexternal",
                    "forwardrequest", "proxyrequest"],
    importPatterns: ["axios", "node-fetch", "got", "undici", "superagent"],
  },
  // ------------------------------------------------------------------
  // SINKS — weak crypto
  // ------------------------------------------------------------------
  {
    id: "sink-weak-crypto",
    role: "sink",
    category: "weak-crypto",
    languages: ["typescript", "javascript"],
    description: "Weak/broken cryptographic algorithm (MD5, SHA-1, DES, RC4)",
    labelPatterns: ["hashmd5", "hashsha1", "md5hash", "sha1hash",
                    "weakcipher", "desencrypt", "rc4encrypt"],
    importPatterns: ["crypto", "node:crypto", "md5", "sha1"],
  },
];

// ---------------------------------------------------------------------------
// User override loading
// ---------------------------------------------------------------------------

export interface UserOverrideFile {
  /** Patterns to ADD to the built-in catalog. */
  add?: SourceSinkPattern[];
  /** Pattern IDs to REMOVE from the built-in catalog. */
  remove?: string[];
}

/**
 * Load an optional user override JSON file.
 * If the path does not exist or is invalid, returns null.
 */
export function loadUserOverride(overridePath: string): UserOverrideFile | null {
  if (!existsSync(overridePath)) return null;
  try {
    const raw = readFileSync(overridePath, "utf8");
    return JSON.parse(raw) as UserOverrideFile;
  } catch {
    return null;
  }
}

/**
 * Build the effective catalog by applying user overrides to built-in patterns.
 */
export function buildEffectiveCatalog(userOverridePath?: string): SourceSinkPattern[] {
  let patterns = [...BUILT_IN_PATTERNS];

  if (userOverridePath) {
    const override = loadUserOverride(userOverridePath);
    if (override) {
      if (override.remove && Array.isArray(override.remove)) {
        const removeSet = new Set(override.remove);
        patterns = patterns.filter((p) => !removeSet.has(p.id));
      }
      if (override.add && Array.isArray(override.add)) {
        patterns.push(...override.add);
      }
    }
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Matching logic
// ---------------------------------------------------------------------------

function labelMatches(nodeLabel: string, patterns: string[]): boolean {
  const lower = nodeLabel.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

/**
 * Scan all nodes in the store and return matched sources and sinks.
 *
 * @param store            - GraphRepository to scan
 * @param userOverridePath - optional path to a user JSON override file
 */
export function buildSourceSinkCatalog(
  store: GraphRepository,
  userOverridePath?: string,
): SourceSinkCatalogResult {
  const patterns = buildEffectiveCatalog(userOverridePath);
  const allNodes = store.allNodes();

  const sources: MatchedNode[] = [];
  const sinks: MatchedNode[] = [];
  const seenSrc = new Set<string>();
  const seenSink = new Set<string>();

  for (const node of allNodes) {
    for (const pattern of patterns) {
      if (!labelMatches(node.label, pattern.labelPatterns)) continue;
      const matched: MatchedNode = { node, pattern, matchedOn: "label" };
      if (pattern.role === "source" && !seenSrc.has(node.id)) {
        seenSrc.add(node.id);
        sources.push(matched);
      } else if (pattern.role === "sink" && !seenSink.has(node.id)) {
        seenSink.add(node.id);
        sinks.push(matched);
      }
    }
  }

  return {
    catalogVersion: CATALOG_VERSION,
    sources,
    sinks,
  };
}
