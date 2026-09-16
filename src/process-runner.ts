import { spawn } from "node:child_process";
import type { ProcessRunSpec } from "./grants.js";

/** Fixed argv and stdin only. A Recipe supplies its own positive timeout. */
export function runProcess(spec: ProcessRunSpec): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...(spec.args ?? [])], {
      cwd: spec.cwd, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let aborted = spec.signal?.aborted === true;
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* The process can exit before cancellation reaches it. */ }
    };
    const abort = () => { aborted = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, spec.timeoutMs);
    spec.signal?.addEventListener("abort", abort, { once: true });
    if (aborted) kill();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.resume();
    child.stdin.on("error", () => { /* Early exit is reported by close. */ });
    child.stdin.end(spec.stdin);
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", kill); // A descendant may still hold the leader's stdout open.
    child.once("close", (code) => {
      cleanup();
      kill(); // Reap same-group descendants even when the leader exits first.
      if (timedOut) reject(new Error(`command timed out after ${spec.timeoutMs}ms`));
      else if (aborted) reject(new Error("command aborted"));
      else if (code !== 0) reject(new Error(`command exited with status ${code}`));
      else resolve(output);
    });
    function cleanup() {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", abort);
    }
  });
}
