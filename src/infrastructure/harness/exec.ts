// infrastructure/harness/exec.ts — ProcessRunnerPort implementation over
// node:child_process for the harness `command` gate.
//
// Gate commands are authored as shell one-liners (`npm test && npm run lint`),
// so — like the origin harness-framework, which ran them via execa's
// `shell: true` — they are dispatched through the platform shell:
// `sh -c <command>` on POSIX, `cmd.exe /d /s /c <command>` on Windows.
// The command string comes from trusted rule files (.harness/rules/, bundled
// assets), never from untrusted input; the shell is the feature here, not an
// injection surface. The inherited PATH is kept intact on purpose: gates must
// resolve the project's own toolchain (npm, node version managers).
//
// Never throws: spawn failures surface as exitCode -1 with the error message
// in `all`; timeouts kill the process group and set `timedOut`.

import { spawn } from "node:child_process";
import {
  type ProcessRunnerPort,
  type ShellRunOptions,
  type ShellRunResult,
} from "../../domain/harness/ports.ts";

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    return { file: comspec, args: ["/d", "/s", "/c", command] };
  }
  return { file: "sh", args: ["-c", command] };
}

export class ShellProcessRunner implements ProcessRunnerPort {
  runShell(command: string, options: ShellRunOptions): Promise<ShellRunResult> {
    const { file, args } = shellInvocation(command);
    return new Promise((resolvePromise) => {
      let stdout = "";
      let all = "";
      let timedOut = false;
      let settled = false;

      const settle = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ exitCode, stdout, all, timedOut });
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, {
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          stdio: ["ignore", "pipe", "pipe"],
          // Own process group on POSIX so a timeout can kill the whole tree.
          detached: process.platform !== "win32",
        });
      } catch (err) {
        all = (err as Error).message;
        resolvePromise({ exitCode: -1, stdout: "", all, timedOut: false });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, options.timeoutMs);
      timer.unref?.();

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        all += text;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        all += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        all += all === "" ? err.message : `\n${err.message}`;
        settle(-1);
      });
      child.on("close", (code) => {
        settle(code ?? -1);
      });
    });
  }
}

function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform !== "win32" && typeof child.pid === "number") {
      // Negative pid = kill the whole process group (requires detached: true).
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // Process already gone — nothing to do.
  }
}
