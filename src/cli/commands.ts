// cli/commands.ts — the one table of every `leina` command: argument synopsis, flags,
// summary and help text. Single source of truth for
//   - the root help, `leina <cmd> --help` / `-h` and `leina help <cmd>` (renderHelp),
//   - the dispatcher's usage checks (resolveInvocation): an unknown command, sub-command or
//     flag, and a flag missing its value, are usage errors (exit 2) before any handler runs;
//     `--flag=value` is accepted as `--flag value`,
//   - which flags take a value (valueFlags), so handlers never read a flag value as a
//     positional (`leina visualize --out x.html` once used "x.html" as the project dir).
// Pure data + pure functions: no I/O, so the table is unit-testable and cheap to load.

/** Root-help sections, in display order. */
export type Section = "everyday" | "graph" | "memory" | "setup" | "health" | "multi-repo" | "integrations";

const SECTION_TITLES: Record<Section, string> = {
  everyday: "Everyday",
  graph: "Code graph",
  memory: "Project memory",
  setup: "Install and per-repo setup",
  health: "Health and diagnostics",
  "multi-repo": "Multi-repo workspaces and audit",
  integrations: "Integrations and tooling",
};

export interface FlagSpec {
  /** As typed: "--json". */
  name: string;
  /** Placeholder of the flag's value ("<n>"); absent for a boolean flag. */
  value?: string;
  desc: string;
}

export interface CommandSpec {
  /** Words after `leina`: "query", "memory search", "harness contract new". */
  path: string;
  /** Argument synopsis after the path — one entry per alternative form. */
  args?: string[];
  /** One line, shown in the parent's listing. */
  summary: string;
  /** Help body: positional rules, behaviour, exit codes, examples. */
  details?: string;
  flags?: FlagSpec[];
  /** Root-help section (top-level commands only). */
  section?: Section;
  /** Other spellings of the LAST path word ("compile" for "harness sync"). */
  aliases?: string[];
  /** A group whose bare invocation runs something (mcp → the server, sidecar → status,
   *  audit → the full audit) instead of printing its help. */
  runsBare?: boolean;
  /** With runsBare: the bare form takes positionals too (`audit <dir>`), so an unknown
   *  first word is its argument rather than an unknown sub-command. */
  bareArgs?: boolean;
  /** Hook entry points: never validated nor intercepted for --help — they are fail-open,
   *  and an exit 2 from a hook means "block" to some hosts. */
  freeArgs?: boolean;
}

// ---------------------------------------------------------------------------
// Shared help fragments
// ---------------------------------------------------------------------------

/** Help paragraphs, separated by a blank line. */
function paragraphs(...parts: string[]): string {
  return parts.join("\n\n");
}

const DIR_RULE =
  "<dir> is optional: any directory inside the project (default: the current directory).\n" +
  "It is resolved to the project root — the nearest enclosing directory that is already a\n" +
  "leina project (graph, consent flag or name lock), else the git toplevel — so a command\n" +
  "run from a subdirectory acts on the repo's graph and memory, never on a second one.\n" +
  "An explicit <dir> that does not exist is a usage error.";

const SELECTORS =
  "Symbol selectors match EXACTLY (never by substring): a node id, path/to/file.ts:name\n" +
  "(the path may be a /-aligned suffix), a name (case-insensitive allowed), Class.method,\n" +
  "or a file path (the module). Several matches → the best one is used and a note on stderr\n" +
  "lists the others with their selectors. No exact match → 'did you mean' and exit 1.";

const MEMORY_DIR_RULE =
  "<dir> is optional for every sub-command (default: the current directory) and is resolved\n" +
  "to the project root like the graph commands. Positional rules:\n" +
  "  search / verified        the first word is <dir> only when it is an existing directory\n" +
  "                           AND more words follow; otherwise every word is the query\n" +
  "  get / update / resolve / reopen\n" +
  "                           one positional = <id>; two = <dir> <id>\n" +
  "  every other sub-command  at most one positional: <dir>";

const TYPE_VALUES = "decision | bugfix | discovery | pattern | architecture | config | preference | manual";
const SCOPE_VALUES = "project | personal | workspace | path | skill | process | technology | security | infra";

const F = {
  json: (desc = "machine-readable JSON on stdout"): FlagSpec => ({ name: "--json", desc }),
  dryRun: (desc = "report what would change, change nothing"): FlagSpec => ({ name: "--dry-run", desc }),
  type: (desc: string): FlagSpec => ({ name: "--type", value: "<type>", desc }),
  scope: (desc: string): FlagSpec => ({ name: "--scope", value: "<scope>", desc }),
  limit: (desc: string): FlagSpec => ({ name: "--limit", value: "<n>", desc }),
  batch: (desc: string): FlagSpec => ({ name: "--batch", desc }),
  atomic: (): FlagSpec => ({ name: "--atomic", desc: "with --batch: all-or-nothing" }),
  hosts: (desc: string): FlagSpec => ({ name: "--hosts", value: "<a,b>", desc }),
  project: (): FlagSpec => ({ name: "--project", value: "<dir>", desc: "the repo (same as the positional <dir>)" }),
  single: (): FlagSpec => ({ name: "--single", desc: "force single-repo mode" }),
  workspace: (): FlagSpec => ({ name: "--workspace", desc: "force workspace (multi-repo) mode" }),
};

const ASSET_FLAGS: FlagSpec[] = [
  F.hosts("AI hosts to install for: devin, claude (REQUIRED unless chosen before)"),
  { name: "--no-user-hooks", desc: "no user-global hooks (strips ours)" },
  { name: "--preset", value: "<minimal|sdd|full>", desc: "asset bundle from assets/catalog.json" },
  { name: "--skills", value: "<a,b|all|none>", desc: "skills to install" },
  { name: "--agents", value: "<a,b|all|none>", desc: "agents to install" },
  { name: "--mcp", desc: "also register the MCP server user-globally (needs --mcp-hosts)" },
  { name: "--mcp-hosts", value: "<claude,cursor,windsurf>", desc: "MCP hosts for --mcp" },
];

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const COMMANDS: readonly CommandSpec[] = [
  // ── Everyday graph reads ────────────────────────────────────────────────────
  {
    path: "query",
    section: "everyday",
    args: ["[<dir>] <question...>"],
    summary: "relevance-ranked subgraph for a question, file:line per node",
    details: paragraphs(
      "Free text in English or Spanish. Prints the seeds, up to 25 nodes (kind + file:line)\n" +
      "and their semantic edges (with the file:line where each happens). Test/mock/fixture\n" +
      "nodes are left out unless --include-tests (or the question is about tests). Routes\n" +
      "through the freshness gate: a stale graph is rebuilt first (posture auto).\n\n" +
      "Positionals: one word or one quoted string is the question. With two or more, the first\n" +
      "is <dir> only when it is an existing directory; otherwise every word is part of the\n" +
      "question. To ask about a word that is also a directory name, give the dir first:\n" +
      "  leina query . src layout",
      DIR_RULE,
    ),
    flags: [
      F.json("one line of JSON — the MCP graph_query shape"),
      { name: "--include-tests", desc: "keep test/mock/fixture nodes" },
    ],
  },
  {
    path: "affected",
    section: "everyday",
    args: ["[<dir>] <symbol>"],
    summary: "blast radius — run before renaming or migrating a symbol",
    details:
      "One line per dependent: its label, the relation, and the file:line where the dependency\n" +
      "happens (the call site). Interfaces are followed both ways (implementations ↔ callers\n" +
      "of the port).\n\n" +
      "Positionals: one = <symbol>; two = <dir> <symbol> (the first must be a directory).\n\n" +
      `${SELECTORS}\n\n${DIR_RULE}`,
    flags: [{ name: "--depth", value: "<n>", desc: "levels of dependents to follow (default 3)" }],
  },
  {
    path: "path",
    section: "everyday",
    args: ["[<dir>] <from> <to>"],
    summary: "shortest dependency path between two symbols",
    details:
      "Prints the start node, then one line per hop with the edge's file:line. The search\n" +
      "ignores direction, the output does not: '--calls-->' means the previous node calls the\n" +
      "next; '<--calls--' means the next node calls the previous one.\n\n" +
      "Positionals: two = <from> <to>; three = <dir> <from> <to> (the first must be a directory).\n\n" +
      `${SELECTORS}\n\n${DIR_RULE}`,
  },
  {
    path: "status",
    section: "everyday",
    args: ["[<dir>]"],
    summary: "is the graph fresh? posture, last build (no rebuild)",
    details: DIR_RULE,
  },
  {
    path: "doctor",
    section: "everyday",
    args: ["[<dir>]"],
    summary: "diagnose install + project health (exit 1 when a check fails)",
    details: paragraphs(
      "Checks the environment, the global share and host links, the project wiring (consent,\n" +
      "workspace trust, hooks, AGENTS.md), memory and graph freshness. Exit 1 only when a check\n" +
      "fails. `leina verify` is the same report as a CI gate.",
      DIR_RULE,
    ),
    flags: [F.json("the full DoctorReport")],
  },

  // ── Code graph ──────────────────────────────────────────────────────────────
  {
    path: "build",
    section: "graph",
    args: ["[<dir>]"],
    summary: "build or incrementally update the graph (.leina/graph.db)",
    details: paragraphs(
      "Reuses the per-file TypeScript extraction of the previous build where it is still\n" +
      "valid; `leina refresh` re-extracts everything. Refuses a <dir> that does not exist.",
      DIR_RULE,
    ),
    flags: [
      F.json("also export a node-link dump to .leina/graph.json"),
      { name: "--profile", desc: "print per-stage timings" },
    ],
  },
  {
    path: "refresh",
    section: "graph",
    args: ["[<dir>]"],
    summary: "full rebuild now: re-extracts every file, reuses no cache",
    details: paragraphs(
      "The escape hatch from any incremental-cache problem: unlike `build` it never reuses a\n" +
      "per-file extraction cached by a previous build (.leina/extract-cache.db), and leaves a\n" +
      "fresh cache for the next build.",
      DIR_RULE,
    ),
  },
  {
    path: "stats",
    section: "graph",
    args: ["[<dir>]"],
    summary: "node/edge counts + edge confidence breakdown",
    details: DIR_RULE,
  },
  {
    path: "impact",
    section: "graph",
    summary: "bidirectional impact analysis: files, tests, services, configs",
  },
  {
    path: "impact analyze",
    args: ["[<dir>] <symbol>"],
    summary: "what a symbol reaches: files, tests, services, configs",
    details:
      "Positionals: one = <symbol>; two = <dir> <symbol> (the first must be a directory).\n" +
      "With no exact match it exits 1 (with --json stdout still carries the empty shape plus\n" +
      "seed: null and suggestions).\n\n" +
      `${SELECTORS}\n\n${DIR_RULE}`,
    flags: [F.json('{"impacted":{"files","tests","services","configs"}}'), { name: "--depth", value: "<n>", desc: "traversal depth" }],
  },
  {
    path: "visualize",
    section: "graph",
    args: ["[<dir>]"],
    summary: "export an offline, interactive HTML graph viewer",
    details: paragraphs(
      "Writes <root>/.leina/graph.html by default. On a multi-repo workspace root it builds or\n" +
      "merges the member graphs (never clobbering the merged graph) and renders the\n" +
      "constellation view; --drilldown renders the merged graph coloured by repo.",
      DIR_RULE,
    ),
    flags: [
      { name: "--out", value: "<path>", desc: "output .html path" },
      { name: "--drilldown", desc: "workspace: merged graph coloured by repo" },
      F.single(),
      F.workspace(),
    ],
  },
  {
    path: "graph",
    section: "graph",
    summary: "graph server and registry housekeeping",
  },
  {
    path: "graph serve",
    args: ["[<dir>]"],
    summary: "read-only JSON API over the graph (loopback, foreground)",
    details: DIR_RULE,
    flags: [
      { name: "--port", value: "<n>", desc: "port (0 = any free one)" },
      { name: "--host", value: "<h>", desc: "127.0.0.1, ::1 or localhost" },
    ],
  },
  {
    path: "graph gc",
    summary: "prune vanished roots from ~/.leina/projects.json",
    flags: [F.dryRun(), F.json()],
  },

  // ── Project memory ──────────────────────────────────────────────────────────
  {
    path: "memory",
    section: "memory",
    args: ["<sub-command> [<dir>] [args]"],
    summary: "project memory: decisions, fixes, discoveries (drift-checked)",
    details: paragraphs(
      "Observations live in the global ~/.leina/memory.db, keyed by the project key (git\n" +
      "remote / repo root / name lock — subdirectories and worktrees share their repo's key).\n" +
      `--type: ${TYPE_VALUES}\n` +
      `--scope: ${SCOPE_VALUES}`,
      MEMORY_DIR_RULE,
    ),
  },
  {
    path: "memory save",
    args: ['[<dir>] --title "..." --content "..."', "[<dir>] --batch [--atomic]"],
    summary: "save an observation (--topic upserts an existing one in place)",
    details: paragraphs(
      "--batch reads a JSON array of {title, content, type?, topicKey?, scope?, anchors?} on\n" +
      "stdin. Save right after a decision, a bug fix or a non-obvious discovery.",
      MEMORY_DIR_RULE,
    ),
    flags: [
      { name: "--title", value: "<text>", desc: "short title (required)" },
      { name: "--content", value: "<text>", desc: "the observation (required)" },
      F.type(`${TYPE_VALUES} (default manual)`),
      { name: "--topic", value: "<key>", desc: "stable topic_key: evolve that entry in place" },
      F.scope("default project"),
      { name: "--anchors", value: "<a,b>", desc: "graph symbols the note is about (drift-checked)" },
      F.batch("read a JSON array of observations on stdin"),
      F.atomic(),
    ],
  },
  {
    path: "memory update",
    args: ["[<dir>] <id> [flags]", "[<dir>] --batch [--atomic]"],
    summary: "update an observation in place (fields or lifecycle status)",
    details: `--batch reads [{id, title?, content?, type?, anchors?, status?, resolution?}] on stdin.\n\n${MEMORY_DIR_RULE}`,
    flags: [
      { name: "--title", value: "<text>", desc: "new title" },
      { name: "--content", value: "<text>", desc: "new content" },
      F.type("new type"),
      { name: "--anchors", value: "<a,b>", desc: "replace the anchors" },
      { name: "--status", value: "<active|resolved|obsolete>", desc: "lifecycle status" },
      { name: "--resolution", value: "<text>", desc: "how or why it was resolved" },
      F.batch("read a JSON array of updates on stdin"),
      F.atomic(),
    ],
  },
  {
    path: "memory resolve",
    args: ['[<dir>] <id> [--note "..."] [--obsolete]', "[<dir>] --batch [--atomic]"],
    summary: "close a note that is done or no longer true (kept in search)",
    details: `--batch reads a JSON array of ids or {id, note?, obsolete?} on stdin.\n\n${MEMORY_DIR_RULE}`,
    flags: [
      { name: "--note", value: "<text>", desc: "how or why" },
      { name: "--obsolete", desc: "mark obsolete instead of resolved" },
      F.batch("read a JSON array on stdin"),
      F.atomic(),
    ],
  },
  {
    path: "memory reopen",
    args: ["[<dir>] <id>"],
    summary: "set a resolved/obsolete note back to active",
    details: MEMORY_DIR_RULE,
  },
  {
    path: "memory search",
    args: ["[<dir>] <query...>"],
    summary: "full-text search (ranked; resolved notes rank last)",
    details: `Search BEFORE re-deriving something that may already be saved.\n\n${MEMORY_DIR_RULE}`,
    flags: [
      F.type("only this type"),
      F.scope("default project"),
      F.limit("max hits (default 10)"),
    ],
  },
  {
    path: "memory verified",
    args: ["[<dir>] <query...>"],
    summary: "search + drift check (USABLE / WARNING / DO NOT USE)",
    details: MEMORY_DIR_RULE,
    flags: [
      F.type("only this type"),
      F.scope("default project"),
      F.limit("max hits (default 10)"),
    ],
  },
  {
    path: "memory get",
    args: ["[<dir>] <id>", "[<dir>] --batch"],
    summary: "one observation in full",
    details: `--batch reads a JSON array of ids on stdin.\n\n${MEMORY_DIR_RULE}`,
    flags: [F.batch("read a JSON array of ids on stdin")],
  },
  {
    path: "memory context",
    args: ["[<dir>]"],
    summary: "recent sessions + the most relevant active notes",
    details: MEMORY_DIR_RULE,
    flags: [F.limit("notes to show (default 10)")],
  },
  {
    path: "memory session",
    args: ['[<dir>] --content "summary"'],
    summary: "save the end-of-session summary",
    details: MEMORY_DIR_RULE,
    flags: [
      { name: "--content", value: "<text>", desc: "the summary (required)" },
      { name: "--title", value: "<text>", desc: "session title" },
    ],
  },
  {
    path: "memory session-start",
    args: ["[<dir>]"],
    summary: "open a new session and print its id",
    details: MEMORY_DIR_RULE,
    flags: [{ name: "--title", value: "<text>", desc: "session title" }],
  },
  {
    path: "memory suggest-topic",
    args: ['[<dir>] --title "..."'],
    summary: "suggest a normalized topic_key and list near matches",
    details: MEMORY_DIR_RULE,
    flags: [
      { name: "--title", value: "<text>", desc: "the observation title (required)" },
      F.type("observation type (default manual)"),
    ],
  },
  {
    path: "memory current-project",
    args: ["[<dir>]"],
    summary: "print the derived project key and how it was detected",
    details: MEMORY_DIR_RULE,
  },
  {
    path: "memory merge-projects",
    args: ["[<dir>] --from <key> --to <key>"],
    summary: "move observations to another project key",
    details: MEMORY_DIR_RULE,
    flags: [
      { name: "--from", value: "<key>", desc: "source project key (required)" },
      { name: "--to", value: "<key>", desc: "destination project key (required)" },
      F.dryRun(),
    ],
  },
  {
    path: "memory reanchor",
    args: ["[<dir>]"],
    summary: "anchor notes to the symbols they name; upgrade file anchors",
    details: MEMORY_DIR_RULE,
    flags: [F.dryRun()],
  },
  {
    path: "memory compact",
    args: ["[<dir>]"],
    summary: "GC superseded snapshots (and old sessions), then VACUUM",
    details: MEMORY_DIR_RULE,
    flags: [
      { name: "--keep", value: "<n>", desc: "superseded snapshots kept per topic (default 0)" },
      { name: "--sessions-older-than", value: "<days>", desc: "also purge sessions idle this long" },
      { name: "--keep-sessions", value: "<n>", desc: "newest sessions always kept by that purge" },
      F.dryRun(),
    ],
  },
  {
    path: "memory export",
    args: ["[<dir>]"],
    summary: "dump this project's observations + anchors as JSONL",
    details: MEMORY_DIR_RULE,
    flags: [{ name: "--out", value: "<file>", desc: "write to a file instead of stdout" }],
  },
  {
    path: "memory import",
    args: ["[<dir>]"],
    summary: "merge an export (stdin or --in); newer revision wins",
    details: MEMORY_DIR_RULE,
    flags: [{ name: "--in", value: "<file>", desc: "read from a file instead of stdin" }],
  },
  {
    path: "memory sync",
    args: ["[<dir>]"],
    summary: "two-way merge with .leina/memory-export.jsonl (committable)",
    details: MEMORY_DIR_RULE,
  },

  // ── Install and per-repo setup ──────────────────────────────────────────────
  {
    path: "setup",
    section: "setup",
    args: ["--hosts devin,claude [flags]"],
    summary: "machine-wide: activate + blanket mode ON (init goes LIGHT)",
    details: "Idempotent. --hosts is required (leina never picks an AI host for you) unless a\nprevious activate/setup already chose them.",
    flags: ASSET_FLAGS,
  },
  {
    path: "activate",
    section: "setup",
    args: ["--hosts devin,claude [flags]"],
    summary: "install skills/agents + user-global grant and hooks",
    details:
      "Writes the Exec(leina) grant in ~/.config/devin/config.json and the managed hooks of each\n" +
      "selected host (Devin config, ~/.claude/settings.json); a deselected host or\n" +
      "--no-user-hooks gets ours stripped. Omit the asset flags to keep the previous choice.",
    flags: ASSET_FLAGS,
  },
  {
    path: "init",
    section: "setup",
    args: ["[<dir>] [flags]"],
    summary: "per-repo opt-in: consent, trust (+ AGENTS.md, host wiring)",
    details:
      "Acts on <dir> exactly as given (default: the current directory) — it creates the\n" +
      "project, so it is never resolved upwards. Under blanket mode (`setup`) init is LIGHT\n" +
      "(consent + .gitignore + trust). Otherwise it is FULL and needs --hosts and --profile.\n" +
      "It does not run `activate` (it only points at it when activation is missing), never\n" +
      "builds unless --build, and seeds the task harness only with --harness.",
    flags: [
      F.project(),
      F.hosts("hosts to wire: devin, claude (required for a FULL init unless chosen before)"),
      { name: "--profile", value: "<devin|windsurf>", desc: "AGENTS.md profile (required for a FULL init)" },
      { name: "--freshness", value: "<auto|refuse>", desc: "stale-graph posture of the reads" },
      { name: "--build", desc: "build the graph now, in the foreground" },
      { name: "--name", value: "<name>", desc: "lock the project key in .leina/config.json" },
      { name: "--mcp", desc: "register the MCP server in the project .mcp.json" },
      { name: "--claude-hooks", desc: "write Claude Code hooks even when claude is not in --hosts" },
      { name: "--harness", desc: "seed + sync the task harness (opt-in)" },
      { name: "--harness-preset", value: "<generic|leina-native>", desc: "harness seed (implies --harness)" },
    ],
  },
  {
    path: "deinit",
    section: "setup",
    args: ["[<dir>]"],
    summary: "per-repo teardown (inverse of init)",
    details: "Acts on <dir> exactly as given (default: the current directory). Idempotent.",
    flags: [F.project()],
  },
  {
    path: "deactivate",
    section: "setup",
    summary: "global teardown (inverse of activate; blanket untouched)",
  },
  {
    path: "disable",
    section: "setup",
    summary: "inverse of setup: global teardown + blanket mode OFF",
  },
  {
    path: "repair",
    section: "setup",
    args: ["[<dir>]"],
    summary: "re-run the install writers for what doctor finds broken",
    details: paragraphs(
      "Never a first install, never grants workspace trust, respects deinit, never touches the\n" +
      "databases. Ends by re-running doctor; remaining failures exit 1.",
      DIR_RULE,
    ),
    flags: [
      F.project(),
      { name: "--no-user-hooks", desc: "re-activate without user-global hooks" },
      { name: "--write-shell-wrapper", desc: "Windows Git Bash: write the ~/.bashrc wrapper" },
    ],
  },

  // ── Health and diagnostics ──────────────────────────────────────────────────
  {
    path: "verify",
    section: "health",
    args: ["[<dir>]"],
    summary: "doctor as a CI gate: exit 1 when any check fails",
    details: DIR_RULE,
    flags: [F.json("the DoctorReport plus exitCode")],
  },
  {
    path: "capabilities",
    section: "health",
    summary: "the capability registry shared by the CLI and the MCP server",
  },
  {
    path: "capabilities list",
    summary: "list every capability (schemas with --json)",
    flags: [F.json("ids, descriptions, schemas, transports")],
  },
  {
    path: "version",
    section: "health",
    summary: "print the leina version (aliases: --version, -v)",
  },
  {
    path: "help",
    section: "health",
    args: ["[<command> [<sub-command>]]"],
    summary: "this help, or one command's (same as `leina <command> --help`)",
  },

  // ── Multi-repo ──────────────────────────────────────────────────────────────
  {
    path: "workspace",
    section: "multi-repo",
    args: ["<sub-command> [<dir>]"],
    summary: "multi-repo: merged graph, member freshness, shared memory",
    details:
      "A workspace root is a directory with ≥2 child git repos, or a workspace.json. <dir> is\n" +
      "the workspace root (default: the current directory), used as given.",
  },
  {
    path: "workspace build",
    args: ["[<dir>]"],
    summary: "build/reuse each member and merge them into one graph",
    flags: [F.json("also export .leina/workspace-graph.json"), F.single(), F.workspace()],
  },
  {
    path: "workspace status",
    args: ["[<dir>]"],
    summary: "mode + per-member fresh/stale",
    flags: [F.single(), F.workspace()],
  },
  {
    path: "workspace detect",
    args: ["[<dir>]"],
    summary: "print the detected workspace structure as JSON",
    flags: [F.single(), F.workspace()],
  },
  {
    path: "workspace memory",
    args: ["<context|search> [<dir>] [<query...>]"],
    summary: "federated memory across the members",
  },
  {
    path: "workspace memory context",
    args: ["[<dir>]"],
    summary: "recent sessions + observations across the members",
  },
  {
    path: "workspace memory search",
    args: ["[<dir>] <query...>"],
    summary: "full-text search across the members",
    details: "The first word is <dir> only when it is an existing directory AND more words follow.",
  },
  {
    path: "workspace visualize",
    args: ["[<dir>]"],
    summary: "render the merged graph (constellation or --drilldown)",
    flags: [
      { name: "--out", value: "<path>", desc: "output .html path" },
      { name: "--drilldown", desc: "merged graph coloured by repo" },
      F.single(),
      F.workspace(),
    ],
  },
  {
    path: "audit",
    section: "multi-repo",
    runsBare: true,
    bareArgs: true,
    args: ["[<dir>] [flags]", "<catalog|reachability|pack|visualize> [<dir>] [flags]"],
    summary: "source→sink candidate paths + findings (triage evidence)",
    details: paragraphs(
      "Bare `audit` runs the full audit and writes the pack. Reads the (possibly merged) graph\n" +
      "of <dir>; run `leina workspace build` first on a workspace root.",
      DIR_RULE,
    ),
    flags: [
      { name: "--format", value: "<md|json|html>", desc: "render to stdout (md/json) or audit-graph.html" },
      F.json("alias of --format json"),
      { name: "--from", value: "<id,...>", desc: "entry-point node ids" },
      { name: "--max-pack-kb", value: "<n>", desc: "cap the JSON pack size (default 128)" },
    ],
  },
  {
    path: "audit catalog",
    args: ["[<dir>]"],
    summary: "repos/nodes/edges grouped by repo + the source/sink catalog",
    details: DIR_RULE,
    flags: [F.json()],
  },
  {
    path: "audit reachability",
    args: ["[<dir>] --from <id,...>"],
    summary: "nodes reachable from the entry points",
    details: DIR_RULE,
    flags: [
      { name: "--from", value: "<id,...>", desc: "entry-point node ids" },
      { name: "--backward", desc: "walk the edges backwards" },
      F.json(),
    ],
  },
  {
    path: "audit pack",
    args: ["[<dir>]"],
    summary: "full report (catalog + reachability), written as audit-pack.json",
    details: DIR_RULE,
    flags: [
      { name: "--from", value: "<id,...>", desc: "entry-point node ids" },
      { name: "--max-pack-kb", value: "<n>", desc: "cap the pack size" },
      F.json(),
    ],
  },
  {
    path: "audit visualize",
    args: ["[<dir>]"],
    summary: "offline HTML audit subgraph (audit-graph.html)",
    details: DIR_RULE,
    flags: [
      { name: "--from", value: "<id,...>", desc: "entry-point node ids" },
      { name: "--out", value: "<path>", desc: "output .html path" },
      { name: "--max-pack-kb", value: "<n>", desc: "cap the pack size" },
    ],
  },

  // ── Integrations and tooling ────────────────────────────────────────────────
  {
    path: "mcp",
    section: "integrations",
    runsBare: true,
    args: ["", "<sub-command>"],
    summary: "MCP stdio server (bare) and its host registration",
    details:
      "Tools = the capability registry; every tool takes an optional root (default: the cwd the\n" +
      "host launched the server in; roots outside it are rejected unless LEINA_MCP_ALLOW_ROOTS\n" +
      "lists them). Register it with your host as: command \"leina\", args [\"mcp\"].",
  },
  {
    path: "mcp register",
    summary: "register the server user-globally (covers every project)",
    flags: [F.hosts("MCP hosts: claude, cursor, windsurf (required)")],
  },
  {
    path: "mcp unregister",
    summary: "remove the user-global registrations",
    flags: [F.hosts("MCP hosts: claude, cursor, windsurf")],
  },
  { path: "mcp status", summary: "per-host registration state" },
  {
    path: "env",
    section: "integrations",
    args: ["<sub-command>"],
    summary: "service credentials for skills (names, never values)",
  },
  { path: "env list", summary: "stored names with masked values" },
  {
    path: "env set",
    args: ["<KEY>"],
    summary: "store a value (hidden prompt or piped stdin, never argv)",
  },
  {
    path: "env get",
    args: ["<KEY>"],
    summary: "show a value masked (--reveal only on an interactive terminal)",
    flags: [{ name: "--reveal", desc: "print the plain value (TTY only)" }],
  },
  { path: "env unset", args: ["<KEY>"], summary: "remove a variable" },
  {
    path: "env exec",
    args: ["[--only K1,K2] -- <cmd...>"],
    summary: "run <cmd> with the stored variables in its environment",
    flags: [{ name: "--only", value: "<K1,K2>", desc: "inject only these variables" }],
  },
  {
    path: "harness",
    section: "integrations",
    args: ["<sub-command>"],
    summary: "task harness (opt-in: init --harness): contract and gates",
    details:
      "Rules + executable gates in .harness/ of the repo the current directory belongs to.\n" +
      "Exit codes: 0 ok · 1 gate failure or drift · 2 usage, engine or config error.",
  },
  {
    path: "harness contract",
    args: ["<new|show|edit|end>"],
    summary: "the task contract: goal, scope globs, acceptance criteria",
  },
  {
    path: "harness contract new",
    args: ['--goal "<text>" [flags]'],
    summary: "declare the task contract (records the git base ref)",
    flags: [
      { name: "--goal", value: "<text>", desc: "one sentence: what done looks like (required)" },
      F.type("configured task type"),
      { name: "--scope", value: "<glob>", desc: "files the task may change (repeatable)" },
      { name: "--out-of-scope", value: "<glob>", desc: "files it must not touch (repeatable)" },
      { name: "--criterion", value: "<text>", desc: "acceptance criterion (repeatable)" },
      { name: "--max-retries", value: "<n>", desc: "stop-gate blocks per stop chain (default 3)" },
    ],
  },
  { path: "harness contract show", summary: "print the active contract" },
  {
    path: "harness contract edit",
    args: ["[flags]"],
    summary: "amend the contract (scope widening is explicit, never silent)",
    flags: [
      { name: "--goal", value: "<text>", desc: "replace the goal" },
      { name: "--add-scope", value: "<glob>", desc: "widen the scope (repeatable)" },
      { name: "--add-out-of-scope", value: "<glob>", desc: "exclude more files (repeatable)" },
      { name: "--add-criterion", value: "<text>", desc: "add a criterion (repeatable)" },
      { name: "--check-criterion", value: "<text>", desc: "tick a criterion (repeatable)" },
    ],
  },
  { path: "harness contract end", summary: "archive the task state and close the contract" },
  {
    path: "harness verify",
    summary: "run the gates (0 complete, 1 blocking failure, 2 error)",
    flags: [
      F.json("the full report"),
      { name: "--phase", value: "<p1,p2>", desc: "intake | plan | execute | verify | deliver" },
      { name: "--rule", value: "<id>", desc: "run a single rule" },
    ],
  },
  {
    path: "harness sync",
    aliases: ["compile"],
    summary: "regenerate platform artifacts from the rules (idempotent)",
    flags: [
      { name: "--check", desc: "exit 1 on drift, write nothing (CI)" },
      { name: "--force", desc: "overwrite hand-edited artifacts" },
      { name: "--platforms", value: "<a,b>", desc: "only these platforms" },
    ],
  },
  {
    path: "harness list",
    summary: "resolved rules with source layer and enforcement",
    flags: [
      { name: "--phase", value: "<p>", desc: "only this phase" },
      { name: "--tag", value: "<t>", desc: "only this tag" },
      F.json(),
    ],
  },
  {
    path: "harness hook",
    args: ["<event>"],
    summary: "platform hook entry point (wired by harness sync)",
    freeArgs: true,
  },
  {
    path: "sidecar",
    section: "integrations",
    runsBare: true,
    args: ["[<sub-command>] [csharp|java]"],
    summary: "C#/Java compiler sidecars (bare: status)",
    details: "Without a sidecar C#/Java extract with tree-sitter (call edges best-effort).",
  },
  { path: "sidecar status", summary: "built/installed state and toolchain per language" },
  {
    path: "sidecar build",
    args: ["[csharp|java]"],
    summary: "build with the local toolchain (dotnet SDK / JDK 17+)",
    flags: [{ name: "--force", desc: "rebuild even when built" }],
  },
  {
    path: "sidecar install",
    args: ["[csharp|java]"],
    summary: "download a prebuilt, sha256-verified sidecar",
    flags: [{ name: "--force", desc: "reinstall" }],
  },
  { path: "sidecar clean", args: ["[csharp|java]"], summary: "remove built sidecars" },
  {
    path: "sidecar verify",
    args: ["[csharp|java]"],
    summary: "run the sidecar over a shipped fixture: exit 0 ok/skip, 1 fail",
  },
  {
    path: "scip",
    section: "integrations",
    runsBare: true,
    args: ["[<sub-command>] [go|rust|python]"],
    summary: "third-party SCIP indexers for Go/Rust/Python (bare: status)",
  },
  { path: "scip status", summary: "whether each SCIP indexer is found" },
  { path: "scip verify", args: ["[go|rust|python]"], summary: "index a shipped fixture: exit 0 ok/skip, 1 fail" },
  { path: "scip install", args: ["[go|rust|python]"], summary: "print the install command (never installs)" },
  {
    path: "tui",
    section: "integrations",
    args: ["[<dir>]"],
    summary: "interactive console over the same handlers (needs a terminal)",
  },
  {
    path: "events",
    section: "integrations",
    summary: "the local event outbox (off unless LEINA_EVENTS_PERSIST=1)",
  },
  {
    path: "events tail",
    args: ["[<dir>]"],
    summary: "print the recorded events (<dir> ignored: outbox is global)",
    flags: [F.json("a JSON array")],
  },
  {
    path: "agent-hook",
    section: "integrations",
    aliases: ["devin-hook"],
    args: ["<Event> [--host claude|devin] [--scope user]"],
    summary: "host hook gate (stdin payload; written by the installers)",
    freeArgs: true,
  },
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const BY_PATH = new Map(COMMANDS.map((c) => [c.path, c]));

export function findCommand(path: string): CommandSpec | undefined {
  return BY_PATH.get(path);
}

/** The direct sub-commands of `path` ("" → the top-level commands), in table order. */
export function childrenOf(path: string): CommandSpec[] {
  const depth = path === "" ? 1 : path.split(" ").length + 1;
  const prefix = path === "" ? "" : `${path} `;
  return COMMANDS.filter((c) => c.path.startsWith(prefix) && c.path.split(" ").length === depth);
}

function lastWord(path: string): string {
  return path.slice(path.lastIndexOf(" ") + 1);
}

/** The child of `path` named `word` (or one of its aliases). */
function childNamed(path: string, word: string): CommandSpec | undefined {
  return childrenOf(path).find((c) => lastWord(c.path) === word || c.aliases?.includes(word) === true);
}

/** The flags of `path` that take a value — what `positionals()` must skip over. */
export function valueFlags(path: string): string[] {
  return (findCommand(path)?.flags ?? []).filter((f) => f.value !== undefined).map((f) => f.name);
}

// ---------------------------------------------------------------------------
// Invocation resolution (pure: the dispatcher acts on the result)
// ---------------------------------------------------------------------------

export type Invocation =
  | { kind: "version" }
  | { kind: "help"; path: string } // "" = root help
  /** `argv` is the input with `--flag=value` split into `--flag value` (see splitInline). */
  | { kind: "run"; path: string; argv: string[] }
  | { kind: "usage"; path: string; message: string };

const HELP_TOKENS = new Set(["--help", "-h"]);

/** Tokens before a `--` separator: what follows belongs to another program (`env exec`). */
function ownArgs(args: string[]): string[] {
  const sep = args.indexOf("--");
  return sep < 0 ? args : args.slice(0, sep);
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** ` (did you mean 'x'?)` for a near miss among `options`, else "". */
function didYouMean(word: string, options: string[]): string {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const d = editDistance(word, o);
    if (d < bestD) [best, bestD] = [o, d];
  }
  return best !== undefined && bestD <= Math.max(1, Math.floor(word.length / 3)) ? ` (did you mean '${best}'?)` : "";
}

function subNames(path: string): string[] {
  return childrenOf(path).flatMap((c) => [lastWord(c.path), ...(c.aliases ?? [])]);
}

/** Deepest spec named by `words` from the top: [path, index of the first unconsumed word]. */
function descend(words: string[]): { path: string; next: number } {
  let path = "";
  let i = 0;
  while (i < words.length) {
    const child = childNamed(path, words[i]!);
    if (!child) break;
    path = child.path;
    i++;
  }
  return { path, next: i };
}

/**
 * Split `--flag=value` into `--flag value` for the spec's value flags, so both spellings
 * work everywhere; `=` on a boolean flag is an error. Tokens after `--` are left alone.
 */
function splitInline(spec: CommandSpec, args: string[]): { args: string[] } | { error: string } {
  const sep = args.indexOf("--");
  const own = sep < 0 ? args : args.slice(0, sep);
  const out: string[] = [];
  for (const a of own) {
    const m = /^(--[^=]+)=(.*)$/s.exec(a);
    if (!m) {
      out.push(a);
      continue;
    }
    const f = (spec.flags ?? []).find((x) => x.name === m[1]);
    if (f && f.value === undefined) return { error: `${m[1]} takes no value` };
    // An unknown name stays one token: checkFlags reports it as typed.
    if (f) out.push(m[1]!, m[2]!);
    else out.push(a);
  }
  return { args: sep < 0 ? out : [...out, ...args.slice(sep)] };
}

/** Unknown flags and flags missing their value, checked against the spec. */
function checkFlags(spec: CommandSpec, args: string[]): string | null {
  const flags = spec.flags ?? [];
  const own = ownArgs(args);
  for (let i = 0; i < own.length; i++) {
    const a = own[i]!;
    if (!a.startsWith("--")) continue;
    const f = flags.find((x) => x.name === a);
    if (!f) {
      const known = flags.map((x) => x.name);
      const name = a.replace(/=.*$/s, "");
      const hint = known.length === 0 ? " (it takes no flags)" : didYouMean(name, known);
      return `unknown flag '${name}'${hint}`;
    }
    if (f.value !== undefined) {
      const v = own[i + 1];
      if (v === undefined || v.startsWith("--")) return `${a} requires a value ${f.value}`;
      i++;
    }
  }
  return null;
}

/** `leina help [<command...>]` / `leina --help [...]`: the help of the named command. */
function resolveHelpRequest(first: string, rest: string[]): Invocation {
  if (first === "help" && HELP_TOKENS.has(rest[0] ?? "")) return { kind: "help", path: "help" };
  const { path, next } = descend(rest);
  const word = rest[next];
  if (word === undefined || word.startsWith("-")) return { kind: "help", path };
  const message =
    path === ""
      ? `unknown command '${word}'${didYouMean(word, subNames(""))}`
      : `unknown sub-command '${word}' of '${path}'${didYouMean(word, subNames(path))}`;
  return { kind: "usage", path, message };
}

/** A group given a word that is not one of its sub-commands. */
function resolveGroupArgs(spec: CommandSpec, args: string[], run: Invocation): Invocation {
  const path = spec.path;
  const word = args[0];
  if (word === undefined) return spec.runsBare ? run : { kind: "help", path };
  // A bare-runnable group given a flag, or its own positional (`audit <dir>`): run it.
  if (spec.runsBare && (word.startsWith("--") || spec.bareArgs === true)) {
    const bad = checkFlags(spec, args);
    return bad ? { kind: "usage", path, message: bad } : run;
  }
  // `leina memory . context` — the sub-command must come first.
  const after = args[1];
  const swapped = after !== undefined && childNamed(path, after) !== undefined;
  const message = swapped
    ? `'${word}' is not a sub-command — the sub-command comes first: leina ${path} ${after} ${word}`
    : `unknown sub-command '${word}'${didYouMean(word, subNames(path))}`;
  return { kind: "usage", path, message };
}

/**
 * Classify argv (everything after `leina`): version, a help request, a usage error, or a
 * command to run. Usage errors never reach a handler; a bare group prints its help.
 */
export function resolveInvocation(argv: string[]): Invocation {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "help", path: "" };
  if (first === "version" || first === "--version" || first === "-v") {
    const help = first === "version" && rest.some((a) => HELP_TOKENS.has(a));
    return help ? { kind: "help", path: "version" } : { kind: "version" };
  }
  if (first === "help" || HELP_TOKENS.has(first)) return resolveHelpRequest(first, rest);
  if (!childNamed("", first)) {
    return { kind: "usage", path: "", message: `unknown command '${first}'${didYouMean(first, subNames(""))}` };
  }

  const { path, next } = descend(argv);
  const spec = findCommand(path)!;
  if (spec.freeArgs) {
    // Hook entry points: only a leading --help is a help request; nothing is validated.
    return HELP_TOKENS.has(argv[next] ?? "") ? { kind: "help", path } : { kind: "run", path, argv };
  }
  if (ownArgs(argv.slice(next)).some((a) => HELP_TOKENS.has(a))) return { kind: "help", path };
  const split = splitInline(spec, argv.slice(next));
  if ("error" in split) return { kind: "usage", path, message: split.error };
  const run: Invocation = { kind: "run", path, argv: [...argv.slice(0, next), ...split.args] };
  if (childrenOf(path).length > 0) return resolveGroupArgs(spec, split.args, run);
  const bad = checkFlags(spec, split.args);
  return bad ? { kind: "usage", path, message: bad } : run;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const COL = 32;

/** `  left   summary`, the summary on its own line when `left` is too wide. */
function row(left: string, summary: string, indent = "  "): string {
  const l = `${indent}${left}`;
  return l.length <= COL - 2 ? `${l.padEnd(COL)}${summary}` : `${l}\n${" ".repeat(COL)}${summary}`;
}

function usageLines(spec: CommandSpec): string[] {
  const group = childrenOf(spec.path).length > 0 ? ["<sub-command>"] : [""];
  const forms = spec.args && spec.args.length > 0 ? spec.args : group;
  return forms.map((a) => `  leina ${spec.path}${a ? ` ${a}` : ""}`);
}

function flagLines(flags: FlagSpec[]): string[] {
  return flags.map((f) => row(`${f.name}${f.value ? ` ${f.value}` : ""}`, f.desc));
}

/** Short synopsis used in listings: the first argument form, if any. */
function synopsis(spec: CommandSpec, from: string): string {
  const name = spec.path.slice(from === "" ? 0 : from.length + 1);
  const a = spec.args?.[0];
  return a ? `${name} ${a}` : name;
}

/** Everyday entries of the root help, pointing into the table (left column override). */
const EVERYDAY: readonly (readonly [string, string?])[] = [
  ["query"],
  ["affected"],
  ["path"],
  ["status"],
  ["memory search"],
  ["memory save", 'memory save [<dir>] --title "..." --content "..."'],
  ["memory context"],
  ["doctor"],
];

/** `    a · b · c` lines listing a group's sub-commands, wrapped under the summary column. */
function subList(path: string): string[] {
  const names = childrenOf(path).map((c) => lastWord(c.path));
  const lines: string[] = [];
  let cur = "";
  for (const n of names) {
    const next = cur === "" ? n : `${cur} · ${n}`;
    if (COL + next.length > 96 && cur !== "") {
      lines.push(`${" ".repeat(COL)}${cur}`);
      cur = n;
    } else {
      cur = next;
    }
  }
  if (cur !== "") lines.push(`${" ".repeat(COL)}${cur}`);
  return lines;
}

function rootHelp(): string {
  const out: string[] = [
    "leina — code knowledge graph + project memory for AI agents",
    "",
    "Usage: leina <command> [args]",
    "",
    `${SECTION_TITLES.everyday}:`,
  ];
  for (const [p, left] of EVERYDAY) {
    const spec = findCommand(p)!;
    out.push(row(left ?? synopsis(spec, ""), spec.summary));
  }
  const sections = Object.keys(SECTION_TITLES).filter((s) => s !== "everyday") as Section[];
  for (const s of sections) {
    out.push("", `${SECTION_TITLES[s]}:`);
    for (const c of childrenOf("").filter((x) => x.section === s)) {
      const subs = childrenOf(c.path).length > 0;
      // Leaf commands show their first argument form when it fits the column.
      const syn = synopsis(c, "");
      const left = subs ? `${c.path} <sub>` : syn.length <= COL - 4 ? syn : c.path;
      out.push(row(left, c.summary), ...(subs ? subList(c.path) : []));
    }
  }
  out.push(
    "",
    "<dir> is optional everywhere: it defaults to the current directory and is resolved to the",
    "project root, so commands work the same from any subdirectory (init/deinit take it as is).",
    "Run 'leina <command> --help' (or 'leina help <command>') for arguments, flags and examples.",
    "Exit codes: 0 success · 1 runtime failure · 2 usage error (unknown command or flag,",
    "missing or invalid argument; reported on stderr).",
  );
  return out.join("\n");
}

/** Help text for `path` ("" → the root help). */
export function renderHelp(path: string): string {
  if (path === "") return rootHelp();
  const spec = findCommand(path);
  if (!spec) return rootHelp();
  const out: string[] = [`leina ${spec.path} — ${spec.summary}`, "", "Usage:", ...usageLines(spec)];
  if (spec.aliases && spec.aliases.length > 0) out.push(`  (alias: ${spec.aliases.map((a) => spec.path.replace(/\S+$/, a)).join(", ")})`);
  const subs = childrenOf(path);
  if (subs.length > 0) {
    out.push("", "Sub-commands:");
    for (const c of subs) out.push(row(synopsis(c, path), c.summary));
  }
  if (spec.flags && spec.flags.length > 0) out.push("", "Flags:", ...flagLines(spec.flags));
  if (spec.details) out.push("", spec.details);
  if (subs.length > 0) out.push("", `Run 'leina ${path} <sub-command> --help' for its arguments and flags.`);
  return out.join("\n");
}
