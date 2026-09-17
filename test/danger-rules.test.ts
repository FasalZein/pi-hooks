import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHookHost, normalizeEvent, policyEngineProvider } from "../src/index.js";
import { matchesGlob } from "../src/glob.js";

const dangerous = [
  "rm file", "/bin/rm file", "/usr/bin/rm file", "echo ok && rm file", "echo ok; rm file", "false || rm file", "echo x | rm file",
  "rmdir empty", "unlink file", "shred file", "truncate -s 0 file", "find . -delete", "git clean -fd", "git reset --hard HEAD",
  "git restore file", "git checkout -- file", "git push origin main --force", "git push -f", "rsync --delete a b",
  "docker system prune", "docker volume prune", "docker rm container", "kubectl delete pod app", "terraform destroy",
  "pulumi destroy", "chmod -R 777 x", "chown -R root x", "wipefs disk",
];
const ordinary = ["npm run build", "npm test", "git status", "ls", "git diff", "git log", "pwd", "cat README.md", "npm run verify", "echo ok"];

describe("Glob policy migration", () => {
  it("preserves all 28 dangerous patterns as ask rules and allows ordinary commands", async () => {
    const configPath = new URL("../examples/dangerous-commands.json", import.meta.url).pathname;
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.providers[0].config.rules).toHaveLength(28);
    const host = await createHookHost({ configPath, providers: [policyEngineProvider] });
    expect(host.status().activation).toBe("active");
    for (const [index, command] of dangerous.entries()) {
      const rule = config.providers[0].config.rules[index];
      expect(matchesGlob(rule.match.input.command.glob, command)).toBe(true);
      const calls: string[] = [];
      const event = normalizeEvent("tool_call", { toolName: "bash", toolCallId: `danger-${index}`, input: { command } });
      const accepted = await host.dispatch(event, { cwd: process.cwd(), hasUI: true, ui: { setStatus() {}, confirm: async (_, message) => { calls.push(message); return true; } } });
      expect(accepted.decision).toBe("allow");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(command);
      const denied = await host.dispatch(event, { cwd: process.cwd(), hasUI: false });
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toContain(rule.id);
      expect(denied.reason).toContain("Remedy:");
    }
    for (const command of ordinary) {
      expect((await host.dispatch(normalizeEvent("tool_call", { toolName: "bash", input: { command } }), { cwd: process.cwd(), hasUI: false })).decision).toBe("allow");
    }
  });

  it.each([
    ["rm *", "RM file", true], ["rm *", "echo rm file", false], ["rm *", " rm file", false], ["rm *", "rm ", true],
    ["a.b*", "axb", false], ["file?", "filex", false], ["**x", "line\nx", true], ["x", "x\n", false],
  ])("matches %s against %s as %s", (pattern, value, expected) => expect(matchesGlob(pattern, value)).toBe(expected));

  it("re-asks for the exact Host-final spelling after a transform", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-final-approval-"));
    try {
      const configPath = join(dir, "pi-hooks.jsonc");
      await writeFile(configPath, JSON.stringify({ schemaVersion: 2, modules: [{ id: "rewrite" }], providers: [{ id: "policy-engine", config: { rules: [{ id: "delete", match: { tool: "bash", input: { command: { glob: "rm *" } } }, decision: "ask", scope: "deletion", remedy: "use read" }] } }] }));
      const host = await createHookHost({ configPath, providers: [policyEngineProvider], modules: [{ id: "rewrite", tool_call: { transform: () => ({ input: { command: "  rm disposable" } }) } }] });
      const prompts: string[] = [];
      const result = await host.dispatch(normalizeEvent("tool_call", { toolName: "bash", toolCallId: "exact-final", input: { command: "rm disposable" } }), { cwd: dir, hasUI: true, ui: { setStatus() {}, confirm: async (_title, message) => { prompts.push(message); return true; } } });
      expect(result).toMatchObject({ decision: "allow", input: { command: "  rm disposable" } });
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("Command: rm disposable\n");
      expect(prompts[1]).toContain("Command:   rm disposable\n");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("re-evaluates new danger after a transform and never treats a prior allow as approval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-final-policy-"));
    try {
      const configPath = join(dir, "pi-hooks.jsonc");
      await writeFile(configPath, JSON.stringify({ schemaVersion: 2, modules: [{ id: "rewrite" }], providers: [{ id: "policy-engine", config: { rules: [{ id: "no-delete", match: { input: { command: { glob: "rm *" } } }, decision: "hard-deny", scope: "deletion", remedy: "use read" }] } }] }));
      const host = await createHookHost({ configPath, providers: [policyEngineProvider], modules: [{ id: "rewrite", tool_call: { transform: () => ({ input: { command: "rm file" } }) } }] });
      const result = await host.dispatch(normalizeEvent("tool_call", { toolName: "bash", input: { command: "echo safe" } }), { cwd: dir, hasUI: false });
      expect(result).toMatchObject({ decision: "deny", reason: expect.stringContaining("no-delete") });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
