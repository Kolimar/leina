// cli/handlers/env.ts — `leina env <sub>`: variables for skills that call services.
//
// THE CONTRACT (names, not values — see application/env/store.ts):
//   env set KEY            value via hidden TTY prompt (interactive) or piped stdin
//                          (scripts). NEVER via argv: argv lands in shell history and
//                          agent transcripts.
//   env list               names + masked values only.
//   env get KEY [--reveal] masked by default; --reveal requires a real TTY on stdout, so
//                          a driving agent cannot capture the plain value by piping.
//   env unset KEY          remove.
//   env exec [--only A,B] -- <cmd...>
//                          run <cmd> with the stored variables injected into its
//                          environment. This is how a skill calls an authenticated
//                          service without ever seeing the credential: the secret
//                          travels process-to-process, not through the model context.

import { spawnSync } from "node:child_process";
import {
  ENV_KEY_RE,
  maskValue,
  parseEnvFile,
  removeEnvVar,
  upsertEnvVar,
} from "../../application/env/store.ts";
import { envFilePath, envFilePermsTooOpen, readEnvFile, writeEnvFile } from "../../infrastructure/env/env-file.ts";
import { fail, readStdin } from "../io.ts";
import { hasFlag, optFlag } from "../args.ts";

const USAGE =
  "Usage: leina env <list | set <KEY> | get <KEY> [--reveal] | unset <KEY> | exec [--only K1,K2] -- <cmd...>>";

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
  if (!key || key.startsWith("--")) fail(USAGE);
  if (!ENV_KEY_RE.test(key)) fail(`invalid variable name "${key}" (expected letters/digits/_)`);
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
  if (sep === -1 || sep === rest.length - 1) {
    fail(`env exec: missing command — ${USAGE}`);
  }
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
      fail(USAGE);
  }
}
