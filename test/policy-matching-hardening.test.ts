import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHookHost, normalizeEvent, policyEngineProvider, type PolicyRuleConfig } from "../src/index.js";

async function withRules(rules: readonly PolicyRuleConfig[], run: (dispatch: (toolName: string | undefined, input: Record<string, unknown>, source?: string) => Promise<Awaited<ReturnType<Awaited<ReturnType<typeof createHookHost>>["dispatch"]>>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-hooks-matcher-hardening-"));
  try {
    const configPath = join(dir, "pi-hooks.jsonc");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "policy-engine", config: { rules } }],
    }));
    const host = await createHookHost({ configPath, providers: [policyEngineProvider] });
    await run(async (toolName, input, source) => {
      const event = normalizeEvent("tool_call", { toolName, toolCallId: `${toolName ?? "unnamed"}-${JSON.stringify(input)}`, input });
      if (source !== undefined) event.provenance = { source };
      return host.dispatch(event, { cwd: dir, hasUI: false });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function denyRule(id: string, match: PolicyRuleConfig["match"]): PolicyRuleConfig {
  return { id, match, decision: "deny", scope: "matcher behavior", remedy: "change the complete input" };
}

describe("Policy Rule matcher behavior", () => {
  it("requires exact tool and provenance matches, including a successful sourceId", async () => {
    await withRules([
      denyRule("tool-only", { tool: "tool-only" }),
      denyRule("global-command", { input: { command: { equals: "global" } } }),
      denyRule("exact-bash", { tool: "bash", input: { command: { equals: "tool" } } }),
      denyRule("builtin-only", { provenance: { kind: "builtin" }, input: { command: { equals: "builtin" } } }),
      denyRule("named-extension", { provenance: { kind: "extension", sourceId: "custom-provider" }, input: { command: { equals: "extension" } } }),
      denyRule("any-extension", { provenance: { kind: "extension" }, input: { command: { equals: "extension-without-id" } } }),
    ], async (dispatch) => {
      expect(await dispatch("tool-only", {})).toMatchObject({ decision: "deny", reason: expect.stringContaining("tool-only") });
      expect(await dispatch("read", { command: "global" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("global-command") });
      expect((await dispatch("ba", { command: "tool" })).decision).toBe("allow");
      expect(await dispatch("bash", { command: "builtin" }, "builtin")).toMatchObject({ decision: "deny", reason: expect.stringContaining("builtin-only") });
      expect((await dispatch("bash", { command: "builtin" }, "custom-provider")).decision).toBe("allow");
      expect(await dispatch("greet", { command: "extension" }, "custom-provider")).toMatchObject({ decision: "deny", reason: expect.stringContaining("named-extension") });
      expect((await dispatch("greet", { command: "extension" }, "other-provider")).decision).toBe("allow");
      expect((await dispatch("greet", { command: "extension" })).decision).toBe("allow");
      expect(await dispatch("greet", { command: "extension-without-id" }, "custom-provider")).toMatchObject({ decision: "deny", reason: expect.stringContaining("any-extension") });
      expect((await dispatch("greet", { command: "extension-without-id" })).decision).toBe("allow");
    });
  });

  it("rejects non-string contains and glob values and accepts any matching glob-array member", async () => {
    await withRules([
      denyRule("contains-string", { input: { value: { contains: "2" } } }),
      denyRule("glob-string", { input: { value: { glob: "2*" } } }),
      denyRule("glob-array", { input: { command: { glob: ["first *", "second *"] } } }),
    ], async (dispatch) => {
      expect((await dispatch("custom", { value: 23 })).decision).toBe("allow");
      expect(await dispatch("custom", { command: "second value" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("glob-array") });
    });
  });

  it("normalizes only Bash command fields and collapses path-command whitespace", async () => {
    await withRules([
      denyRule("normalized-delete", { tool: "bash", input: { command: { glob: "rm -rf *" } } }),
      denyRule("generic-command", { tool: "custom", input: { command: { glob: "rm *" } } }),
      denyRule("generic-field", { tool: "bash", input: { note: { glob: "rm *" } } }),
    ], async (dispatch) => {
      expect(await dispatch("bash", { command: "/opt/tools/rm   -rf disposable" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("normalized-delete") });
      expect((await dispatch("bash", { command: "rm   -rf disposable" })).decision).toBe("allow");
      expect((await dispatch("bash", { command: "/opt/tools/not-rm -rf disposable" })).decision).toBe("allow");
      expect((await dispatch("custom", { command: "  rm disposable" })).decision).toBe("allow");
      expect((await dispatch("bash", { note: "  rm disposable" })).decision).toBe("allow");
    });
  });

  it("requires both valid recursive and force flags before path normalization", async () => {
    await withRules([
      denyRule("recursive-force-delete", { tool: "bash", input: { command: { glob: "rm *" } } }),
    ], async (dispatch) => {
      for (const command of [
        "/opt/tools/rm -r disposable",
        "/opt/tools/rm -f disposable",
        "/opt/tools/rm --recursive disposable",
        "/opt/tools/rm --force disposable",
        "/opt/tools/rm wordR -f disposable",
        "/opt/tools/rm wordf -r disposable",
        "/opt/tools/rm x-r -f disposable",
        "/opt/tools/rm -r x-f disposable",
        "/opt/tools/rm --notrecursive --force disposable",
      ]) {
        expect((await dispatch("bash", { command })).decision, command).toBe("allow");
      }
      for (const command of [
        "/opt/tools/rm -rf disposable",
        "/opt/tools/rm -r -f disposable",
        "/opt/tools/rm --recursive --force disposable",
      ]) {
        expect(await dispatch("bash", { command })).toMatchObject({ decision: "deny", reason: expect.stringContaining("recursive-force-delete") });
      }
    });
  });
});
