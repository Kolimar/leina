// cli/handlers/env.ts — `leina env <sub>`: variables for skills that call services.
//
// THE CONTRACT (names, not values — see application/env/store.ts):
//   env set KEY            value via hidden TTY prompt (interactive) or piped stdin
//                          (scripts). NEVER via argv: argv lands in shell history and
//                          agent transcripts.
//   env list               names + masked values only.
//   env get KEY [--reveal] masked by default; --reveal requires a TTY on stdout, so a
//                          driving agent cannot capture the plain value by PIPING.
//                          Honest limit: isTTY is not proof of a human — see envGet.
//   env unset KEY          remove.
//   env exec [--only A,B] -- <cmd...>
//                          run <cmd> with the stored variables injected into its
//                          environment. This is how a skill calls an authenticated
//                          service without ever seeing the credential: the secret
//                          travels process-to-process, not through the model context.
//                          Honest limit: the CHILD's output is not covered — see envExec.
//
// What the contract does and does not guarantee: the value never touches leina's own
// argv, logs, or listings. It does NOT make the value unreachable from a determined
// agent's session (PTY-backed --reveal, or a child that prints it) — those residual
// risks are documented inline below and, for the consumer, in
// assets/skills/authenticated-api/SKILL.md ("Residual risks").

import { spawnSync } from "node:child_process";
import {
  ENV_KEY_RE,
  maskValue,
  parseEnvFile,
  removeEnvVar,
  upsertEnvVar,
} from "../../application/env/store.ts";
import { envFilePath, envFilePermsTooOpen, readEnvFile, writeEnvFile } from "../../infrastructure/env/env-file.ts";
import { fail, readStdin, usageError } from "../io.ts";
import { hasFlag, optFlag } from "../args.ts";

/** Read a secret from an interactive terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    process.stderr.write(question);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          // Ctrl+C
          cleanup();
          process.stderr.write("\n");
          rejectPromise(new Error("cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolvePromise(value);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

function requireKey(key: string | undefined): string {
  if (!key || key.startsWith("--")) usageError("missing <KEY>");
  if (!ENV_KEY_RE.test(key)) usageError(`invalid variable name "${key}" (expected letters/digits/_)`);
  return key;
}

async function envSet(key: string): Promise<void> {
  // Interactive: hidden prompt. Non-interactive (piped): first line of stdin. Both paths
  // keep the value out of argv — an agent asks the HUMAN to run this command.
  const value = process.stdin.isTTY
    ? await promptHidden(`Value for ${key} (input hidden): `)
    : readStdin().split("\n")[0] ?? "";
  writeEnvFile(upsertEnvVar(readEnvFile(), key, value));
  console.log(`${key} saved to ${envFilePath()} (0600, plain text — see 'leina env list').`);
}

function envList(): void {
  const entries = parseEnvFile(readEnvFile());
  if (entries.length === 0) {
    console.log(`no variables stored (${envFilePath()})`);
    return;
  }
  console.log(`leina env — ${envFilePath()} (values masked):`);
  for (const e of entries) console.log(`  ${e.key}=${maskValue(e.value)}`);
  if (envFilePermsTooOpen()) {
    process.stderr.write(`⚠ ${envFilePath()} is readable by group/others — run: chmod 600 ${envFilePath()}\n`);
  }
}

function envGet(key: string, reveal: boolean): void {
  const entry = parseEnvFile(readEnvFile()).find((e) => e.key === key);
  if (!entry) fail(`${key}: not set`);
  if (!reveal) {
    console.log(`${entry.key}=${maskValue(entry.value)}   (add --reveal on an interactive terminal to show it)`);
    return;
  }
  // Reveal only onto a real terminal: piping `env get --reveal` into a file/capture is
  // exactly the leak the names-not-values contract exists to prevent.
  //
  // HONEST LIMIT: isTTY is the best local signal we have, but it is NOT proof of a
  // human. Agent runners that allocate a pseudo-terminal (node-pty and friends) present
  // isTTY === true, so a --reveal executed BY the agent inside such a PTY prints the
  // plain value straight into the agent's context. This gate stops accidental capture
  // (pipes, redirects), not a driving agent with a PTY. Changing the flow (confirmation
  // prompt on the controlling terminal, etc.) is a separate debate — for now the
  // authenticated-api skill instructs agents to never run --reveal at all.
  if (!process.stdout.isTTY) {
    fail(`--reveal requires an interactive terminal (stdout is piped). Use 'leina env exec' to consume the value.`);
  }
  console.log(`${entry.key}=${entry.value}`);
}

function envUnset(key: string): void {
  const next = removeEnvVar(readEnvFile(), key);
  if (next === null) {
    console.log(`${key}: was not set`);
    return;
  }
  writeEnvFile(next);
  console.log(`${key} removed.`);
}

function envExec(rest: string[]): void {
  const sep = rest.indexOf("--");
  if (sep === -1 || sep === rest.length - 1) usageError("missing command — usage: leina env exec [--only K1,K2] -- <cmd...>");
  const only = optFlag(rest.slice(0, sep), "--only", undefined)
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const cmd = rest.slice(sep + 1);
  const entries = parseEnvFile(readEnvFile()).filter((e) => only === undefined || only.includes(e.key));
  // Every explicitly requested key must exist: silently running the child with an EMPTY
  // variable surfaces far downstream (a confusing 401) instead of right here.
  if (only !== undefined) {
    const present = new Set(entries.map((e) => e.key));
    const missing = only.filter((k) => !present.has(k));
    if (missing.length > 0) {
      fail(`env exec: ${missing.join(", ")}: not set — store with 'leina env set <KEY>' first`);
    }
  }
  const childEnv = { ...process.env };
  for (const e of entries) childEnv[e.key] = e.value;
  // stdio:"inherit" — the child's stdout/stderr go to the caller's terminal, and in an
  // agent session that terminal IS the model context. The names-not-values contract
  // covers leina's own surfaces (argv, logs, listings); it ends at the child's output:
  // a child that PRINTS the secret (curl -v tracing the Authorization header, a crash
  // dumping its environment, a plain `env`) leaks it into the transcript. The safe
  // consumption patterns (-sf, no -v, never echo the environment) live in
  // assets/skills/authenticated-api/SKILL.md ("Residual risks").
  const r = spawnSync(cmd[0]!, cmd.slice(1), { stdio: "inherit", env: childEnv });
  if (r.error) fail(`env exec: ${r.error.message}`);
  process.exit(r.status ?? 1);
}

export async function handleEnv(rest: string[]): Promise<void> {
  const sub = rest[0];
  switch (sub) {
    case "set":
      await envSet(requireKey(rest[1]));
      break;
    case "list":
      envList();
      break;
    case "get":
      envGet(requireKey(rest[1]), hasFlag(rest, "--reveal"));
      break;
    case "unset":
      envUnset(requireKey(rest[1]));
      break;
    case "exec":
      envExec(rest.slice(1));
      break;
    default:
      // The dispatcher only routes known sub-commands here.
      usageError(`unknown sub-command '${sub ?? ""}'`, "env");
  }
}
