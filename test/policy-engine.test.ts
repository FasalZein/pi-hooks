import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const hooksIndexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Direct dispatch seam (see .ralph/plan.md "Test seams"): proves decision shape
 * and reason content only — it never executes the tool. */
async function withPolicySession<T>(
  options: { config: string; extensionSource: string },
  run: (session: AgentSession) => Promise<T>,
): Promise<T> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-hooks-policy-"));
  await writeFile(join(agentDir, "pi-hooks.jsonc"), options.config);
  const extraPath = join(agentDir, "policy-extension.ts");
  await writeFile(extraPath, options.extensionSource);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      additionalExtensionPaths: [extraPath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({ resourceLoader: loader, sessionManager: SessionManager.inMemory() });
    try {
      return await run(session);
    } finally {
      session.dispose();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

/** The real bundled surface: src/index.ts's default export carries the Policy Engine. */
const bundledSource = `export { default } from ${JSON.stringify(hooksIndexPath)};`;

/** Policy Engine plus a second tools-grant provider, for provenance matching. */
function withGreeterSource(): string {
  return `
import { Type } from "typebox";
import { createPiHooksExtension, defineProvider, policyEngineProvider } from ${JSON.stringify(hooksIndexPath)};

const greeter = defineProvider({
  manifest: { id: "greeter", version: "1.0.0", grants: ["tools"] },
  activate(facade) {
    facade.tools.registerTool({
      name: "greet",
      label: "Greet",
      description: "extension-registered tool for provenance matching",
      parameters: Type.Object({ who: Type.String() }),
      async execute() { return { content: [{ type: "text", text: "hi" }] }; },
    });
  },
});

export default createPiHooksExtension({ providers: [policyEngineProvider, greeter] });
`;
}

function policyConfig(rules: readonly unknown[], extraProviders: readonly unknown[] = []): string {
  return JSON.stringify({
    schemaVersion: 2,
    providers: [{ id: "policy-engine", enabled: true, config: { rules } }, ...extraProviders],
  });
}

async function emitToolCall(session: AgentSession, toolName: string, input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined> {
  return (await session.extensionRunner!.emitToolCall({
    type: "tool_call",
    toolName,
    toolCallId: `tc-${toolName}-${Math.random().toString(36).slice(2)}`,
    input,
  } as never)) as { block?: boolean; reason?: string } | undefined;
}

describe("SLICE-0011 item 2: rule matching and allow/deny composition", () => {
  it("denies a tool matched by exact name with the rule id and severity in the reason", async () => {
    const config = policyConfig([
      { id: "no-bash", match: { tool: "bash" }, decision: "deny", scope: "shell commands", remedy: "use built-in read-only tools" },
    ]);
    await withPolicySession({ config, extensionSource: bundledSource }, async (session) => {
      const denied = await emitToolCall(session, "bash", { command: "echo hi" });
      expect(denied).toMatchObject({ block: true });
      expect(denied?.reason).toContain("no-bash");
      expect(denied?.reason).toContain("deny");

      const unmatched = await emitToolCall(session, "read", { path: "somewhere.txt" });
      expect(unmatched?.block ?? false).toBe(false);
    });
  }, 30_000);

  it("matches a tool-name array", async () => {
    const config = policyConfig([
      { id: "no-io", match: { tool: ["bash", "read"] }, decision: "deny", scope: "io tools", remedy: "ask the operator" },
    ]);
    await withPolicySession({ config, extensionSource: bundledSource }, async (session) => {
      const denied = await emitToolCall(session, "read", { path: "x.txt" });
      expect(denied).toMatchObject({ block: true });
      expect(denied?.reason).toContain("no-io");
    });
  }, 30_000);

  it("matches provenance kind: denies an extension-registered tool while a builtin passes", async () => {
    const config = policyConfig(
      [{ id: "no-ext-tools", match: { provenance: { kind: "extension" } }, decision: "deny", scope: "extension tools", remedy: "enable the tool's provider policy" }],
      [{ id: "greeter", enabled: true }],
    );
    await withPolicySession({ config, extensionSource: withGreeterSource() }, async (session) => {
      const denied = await emitToolCall(session, "greet", { who: "world" });
      expect(denied).toMatchObject({ block: true });
      expect(denied?.reason).toContain("no-ext-tools");

      const builtin = await emitToolCall(session, "bash", { command: "echo hi" });
      expect(builtin?.block ?? false).toBe(false);
    });
  }, 30_000);

  it("provenance sourceId narrows the match: a different source id does not match", async () => {
    const config = policyConfig(
      [{ id: "no-other-ext", match: { provenance: { kind: "extension", sourceId: "some-other-extension" } }, decision: "deny", scope: "one extension", remedy: "n/a" }],
      [{ id: "greeter", enabled: true }],
    );
    await withPolicySession({ config, extensionSource: withGreeterSource() }, async (session) => {
      const result = await emitToolCall(session, "greet", { who: "world" });
      expect(result?.block ?? false).toBe(false);
    });
  }, 30_000);

  it("input matchers: contains on strings and canonical key-order-insensitive equals on a dot path", async () => {
    const config = policyConfig([
      { id: "no-rm", match: { tool: "bash", input: { command: { contains: "rm -rf" } } }, decision: "deny", scope: "destructive shell", remedy: "delete files individually" },
      { id: "no-secret-env", match: { tool: "bash", input: { "env.SECRET": { equals: { a: 1, b: [1, 2] } } } }, decision: "deny", scope: "secret env", remedy: "unset SECRET" },
    ]);
    await withPolicySession({ config, extensionSource: bundledSource }, async (session) => {
      const clean = await emitToolCall(session, "bash", { command: "echo hi" });
      expect(clean?.block ?? false).toBe(false);

      const rm = await emitToolCall(session, "bash", { command: "rm -rf /tmp/x" });
      expect(rm).toMatchObject({ block: true });
      expect(rm?.reason).toContain("no-rm");

      // Same value as the rule's equals object, with object keys reordered.
      const secret = await emitToolCall(session, "bash", { command: "echo hi", env: { SECRET: { b: [1, 2], a: 1 } } });
      expect(secret).toMatchObject({ block: true });
      expect(secret?.reason).toContain("no-secret-env");
    });
  }, 30_000);

  it("deny beats allow, and an explicit allow-only match does not block", async () => {
    const config = policyConfig([
      { id: "allow-bash", match: { tool: "bash" }, decision: "allow", scope: "shell", remedy: "n/a" },
      { id: "deny-bash", match: { tool: "bash" }, decision: "deny", scope: "shell", remedy: "ask the operator" },
      { id: "allow-read", match: { tool: "read" }, decision: "allow", scope: "reads", remedy: "n/a" },
    ]);
    await withPolicySession({ config, extensionSource: bundledSource }, async (session) => {
      const denied = await emitToolCall(session, "bash", { command: "echo hi" });
      expect(denied).toMatchObject({ block: true });
      expect(denied?.reason).toContain("deny-bash");

      const allowed = await emitToolCall(session, "read", { path: "x.txt" });
      expect(allowed?.block ?? false).toBe(false);
    });
  }, 30_000);

  it("a same-severity tie resolves to the lexicographically smallest rule id", async () => {
    const config = policyConfig([
      { id: "zz-deny", match: { tool: "bash" }, decision: "deny", scope: "shell", remedy: "later" },
      { id: "aa-deny", match: { tool: "bash" }, decision: "deny", scope: "shell", remedy: "sooner" },
    ]);
    await withPolicySession({ config, extensionSource: bundledSource }, async (session) => {
      const denied = await emitToolCall(session, "bash", { command: "echo hi" });
      expect(denied).toMatchObject({ block: true });
      expect(denied?.reason).toContain("aa-deny");
      expect(denied?.reason).not.toContain("zz-deny");
    });
  }, 30_000);

  it("the full outcome is identical under rules-array reordering and object-key reordering", async () => {
    // Same declarative rules, expressed twice: reversed array order and every
    // object's keys written in a different insertion order.
    const configA = policyConfig([
      { id: "allow-bash", match: { tool: "bash" }, decision: "allow", scope: "shell", remedy: "n/a" },
      { id: "zz-deny", match: { tool: "bash", input: { "env.SECRET": { equals: { a: 1, b: 2 } } } }, decision: "deny", scope: "secret env", remedy: "unset SECRET" },
      { id: "aa-deny", match: { input: { "env.SECRET": { equals: { a: 1, b: 2 } } }, tool: "bash" }, decision: "deny", scope: "secret env", remedy: "unset SECRET" },
    ]);
    const configB = policyConfig([
      { match: { tool: "bash", input: { "env.SECRET": { equals: { b: 2, a: 1 } } } }, scope: "secret env", remedy: "unset SECRET", decision: "deny", id: "aa-deny" },
      { decision: "deny", id: "zz-deny", remedy: "unset SECRET", scope: "secret env", match: { input: { "env.SECRET": { equals: { b: 2, a: 1 } } }, tool: "bash" } },
      { decision: "allow", scope: "shell", remedy: "n/a", id: "allow-bash", match: { tool: "bash" } },
    ]);
    const input = { command: "echo hi", env: { SECRET: { a: 1, b: 2 } } };

    const resultA = await withPolicySession({ config: configA, extensionSource: bundledSource }, async (session) =>
      emitToolCall(session, "bash", input));
    const resultB = await withPolicySession({ config: configB, extensionSource: bundledSource }, async (session) =>
      emitToolCall(session, "bash", input));

    expect(resultA).toMatchObject({ block: true });
    expect(resultA?.reason).toContain("aa-deny");
    expect(resultB).toEqual(resultA);
  }, 60_000);
});
