import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

/** Policy tests select the Provider explicitly; the default export is a Bare Host. */
const bundledSource = `import { createPiHooksExtension, policyEngineProvider } from ${JSON.stringify(hooksIndexPath)};
export default createPiHooksExtension({ providers: [policyEngineProvider] });`;

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

function policyConfig(
  rules: readonly unknown[],
  extraProviders: readonly unknown[] = [],
  configExtras: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    schemaVersion: 2,
    providers: [{ id: "policy-engine", enabled: true, config: { rules, ...configExtras } }, ...extraProviders],
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

/** Policy Engine plus a tools-grant provider whose marker tool appends one
 * byte per execution — the file's length counts executions exactly. */
function markerPolicySource(markerPath: string): string {
  return `
import { Type } from "typebox";
import { appendFile } from "node:fs/promises";
import { createPiHooksExtension, defineProvider, policyEngineProvider } from ${JSON.stringify(hooksIndexPath)};

const markerProvider = defineProvider({
  manifest: { id: "marker-tools", version: "1.0.0", grants: ["tools"] },
  activate(facade) {
    facade.tools.registerTool({
      name: "marker",
      label: "Marker",
      description: "appends to a marker file to prove execution",
      parameters: Type.Object({ note: Type.String() }),
      async execute() {
        await appendFile(${JSON.stringify(markerPath)}, "x");
        return { content: [{ type: "text", text: "marked" }] };
      },
    });
  },
});

export default createPiHooksExtension({ providers: [policyEngineProvider, markerProvider] });
`;
}

/** Full ExtensionUIContext stub whose confirm records the request and answers. */
function confirmingUiContext(calls: Array<[string, string]>, answer: boolean): unknown {
  return {
    select: async () => undefined,
    confirm: async (title: string, message: string) => {
      calls.push([title, message]);
      return answer;
    },
    input: async () => undefined,
    notify: () => undefined,
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: () => undefined,
  };
}

const scriptedModel = {
  id: "scripted",
  name: "Scripted",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://scripted.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
};

function transformingPolicySource(): string {
  return `
import { createPiHooksExtension, defineProvider, policyEngineProvider } from ${JSON.stringify(hooksIndexPath)};

const hostTransform = defineProvider({
  manifest: { id: "host-transform", version: "1.0.0", grants: ["events"] },
  activate(facade) {
    facade.events.registerModule({
      id: "host-transform",
      tool_call: {
        transform(invocation) {
          return { input: { ...invocation.input, note: "host-final" } };
        },
      },
    });
  },
});

export default createPiHooksExtension({ providers: [policyEngineProvider, hostTransform] });
`;
}

function scriptedAssistant(content: readonly unknown[], stopReason: "toolUse" | "stop"): Record<string, unknown> {
  return {
    role: "assistant",
    content,
    api: scriptedModel.api,
    provider: scriptedModel.provider,
    model: scriptedModel.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

/** Scripted agent turn seam (see .ralph/plan.md "Test seams"): a deterministic
 * session.agent.streamFunction whose first turn requests one marker tool call
 * and whose second turn stops. The marker side effect proves "executed"; its
 * absence proves "never executed"; the toolResult message in the transcript is
 * the model-visible output. */
let scriptedToolCallSequence = 0;

async function runScriptedToolTurn(
  session: AgentSession,
  toolCall: { name: string; arguments: Record<string, unknown> },
): Promise<{ isError?: boolean; text: string }> {
  const toolCallId = `scripted-call-${++scriptedToolCallSequence}`;
  let turn = 0;
  session.agent.state.model = scriptedModel as never;
  session.agent.streamFunction = ((): unknown => {
    turn += 1;
    const message = turn === 1
      ? scriptedAssistant([{ type: "toolCall", id: toolCallId, name: toolCall.name, arguments: toolCall.arguments }], "toolUse")
      : scriptedAssistant([{ type: "text", text: "done" }], "stop");
    const events = [
      { type: "start", partial: message },
      { type: "done", reason: message.stopReason, message },
    ];
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
      result: async () => message,
    };
  }) as never;
  await session.agent.prompt("run the marker tool");
  const toolResult = session.agent.state.messages.find(
    (message) => (message as { role?: string; toolCallId?: string }).role === "toolResult"
      && (message as { toolCallId?: string }).toolCallId === toolCallId,
  ) as { isError?: boolean; content?: Array<{ type: string; text?: string }> } | undefined;
  expect(toolResult).toBeDefined();
  const text = (toolResult?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  return { isError: toolResult?.isError, text };
}

async function markerExecutions(markerPath: string): Promise<number> {
  try {
    return (await readFile(markerPath, "utf8")).length;
  } catch {
    return 0;
  }
}

describe("SLICE-0011 item 4: ask severity with fail-closed unattended safety", () => {
  const askMarkerRules = [
    { id: "allow-marker", match: { tool: "marker" }, decision: "allow", scope: "marker tool", remedy: "n/a" },
    { id: "ask-marker", match: { tool: "marker" }, decision: "ask", scope: "marker tool", remedy: "approve the confirmation prompt" },
  ];

  function askMarkerConfig(): string {
    return policyConfig(askMarkerRules, [{ id: "marker-tools", enabled: true }]);
  }

  it("direct dispatch: ask + allow compose to ask and block fail-closed when no UI is attached", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-ask-")), "marker.txt");
    await withPolicySession({ config: askMarkerConfig(), extensionSource: markerPolicySource(markerPath) }, async (session) => {
      // No uiContext bound: the runner reports hasUI=false for this session.
      const result = await emitToolCall(session, "marker", { note: "hi" });
      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain("ask-marker");
      expect(result?.reason).toContain("ask");
      expect(result?.reason).not.toContain("allow-marker");
    });
  }, 30_000);

  it("scripted turn: under unattended ask-deny the marker tool never executes and the result is an error", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-ask-")), "marker.txt");
    await withPolicySession({ config: askMarkerConfig(), extensionSource: markerPolicySource(markerPath) }, async (session) => {
      const result = await runScriptedToolTurn(session, { name: "marker", arguments: { note: "hi" } });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("ask-marker");
      expect(await markerExecutions(markerPath)).toBe(0);
    });
  }, 30_000);

  it("scripted turn: with UI the prompt fires exactly once for the action and the tool executes once on accept", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-ask-")), "marker.txt");
    const calls: Array<[string, string]> = [];
    await withPolicySession({ config: askMarkerConfig(), extensionSource: markerPolicySource(markerPath) }, async (session) => {
      await session.bindExtensions({ uiContext: confirmingUiContext(calls, true) as never });
      const result = await runScriptedToolTurn(session, { name: "marker", arguments: { note: "hi" } });
      expect(calls).toHaveLength(1);
      // The prompt names the exact elevated action.
      expect(calls[0].join("\n")).toContain("marker");
      expect(result.isError ?? false).toBe(false);
      expect(await markerExecutions(markerPath)).toBe(1);
    });
  }, 30_000);

  it("scripted turn: with UI the tool is blocked on reject and never executes", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-ask-")), "marker.txt");
    const calls: Array<[string, string]> = [];
    await withPolicySession({ config: askMarkerConfig(), extensionSource: markerPolicySource(markerPath) }, async (session) => {
      await session.bindExtensions({ uiContext: confirmingUiContext(calls, false) as never });
      const result = await runScriptedToolTurn(session, { name: "marker", arguments: { note: "hi" } });
      expect(calls).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("ask-marker");
      expect(await markerExecutions(markerPath)).toBe(0);
    });
  }, 30_000);
});

describe("SLICE-0011 item 6: Host-final approval fingerprints", () => {
  const askMarkerRules = [
    { id: "ask-marker", match: { tool: "marker" }, decision: "ask", scope: "marker tool", remedy: "approve the confirmation prompt" },
  ];

  function askMarkerConfig(configExtras: Readonly<Record<string, unknown>> = {}): string {
    return policyConfig(askMarkerRules, [{ id: "marker-tools", enabled: true }], configExtras);
  }

  it("an approved elevated call executes once and replay requires a new approval", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-fingerprint-")), "marker.txt");
    const calls: Array<[string, string]> = [];
    let answer = true;
    const uiContext = confirmingUiContext(calls, answer) as Record<string, unknown>;
    uiContext.confirm = async (title: string, message: string) => {
      calls.push([title, message]);
      const current = answer;
      answer = false;
      return current;
    };

    await withPolicySession({ config: askMarkerConfig(), extensionSource: markerPolicySource(markerPath) }, async (session) => {
      await session.bindExtensions({ uiContext: uiContext as never });

      const first = await runScriptedToolTurn(session, { name: "marker", arguments: { note: "same" } });
      expect(first.isError ?? false).toBe(false);
      expect(await markerExecutions(markerPath)).toBe(1);

      const replay = await runScriptedToolTurn(session, { name: "marker", arguments: { note: "same" } });
      expect(replay.isError).toBe(true);
      expect(await markerExecutions(markerPath)).toBe(1);
      expect(calls).toHaveLength(2);
    });
  }, 30_000);

  it("an approval past its configured TTL is not honored", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-fingerprint-")), "marker.txt");
    const calls: Array<[string, string]> = [];
    await withPolicySession({
      config: askMarkerConfig({ approvalTtlSeconds: 0 }),
      extensionSource: markerPolicySource(markerPath),
    }, async (session) => {
      await session.bindExtensions({ uiContext: confirmingUiContext(calls, true) as never });
      const result = await runScriptedToolTurn(session, { name: "marker", arguments: { note: "expired" } });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("ask-marker");
      expect(await markerExecutions(markerPath)).toBe(0);
      expect(calls).toHaveLength(1);
    });
  }, 30_000);

  it("requires fresh approval when a transform changes the approved input before internalFinal", async () => {
    const calls: Array<[string, string]> = [];
    const config = policyConfig(
      [{ id: "ask-bash", match: { tool: "bash" }, decision: "ask", scope: "shell", remedy: "approve the exact command" }],
      [{ id: "host-transform", enabled: true }],
    );
    await withPolicySession({ config, extensionSource: transformingPolicySource() }, async (session) => {
      await session.bindExtensions({ uiContext: confirmingUiContext(calls, true) as never });
      const result = await emitToolCall(session, "bash", { command: "echo hi", note: "approved" });
      expect(result).toBeUndefined();
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toContain("echo hi");
      expect(calls[1][1]).toContain("Scope: shell");
    });
  }, 30_000);
});

describe("SLICE-0011 item 5: hard-deny composition", () => {
  it("hard-deny outranks allow, ask, and deny without showing a confirmation", async () => {
    const calls: Array<[string, string]> = [];
    const config = policyConfig([
      { id: "allow-bash", match: { tool: "bash" }, decision: "allow", scope: "shell", remedy: "n/a" },
      { id: "ask-bash", match: { tool: "bash" }, decision: "ask", scope: "shell", remedy: "request approval" },
      { id: "deny-bash", match: { tool: "bash" }, decision: "deny", scope: "shell", remedy: "use a read-only tool" },
      { id: "hard-deny-bash", match: { tool: "bash" }, decision: "hard-deny", scope: "forbidden shell", remedy: "remove the prohibited action" },
    ]);
    await withPolicySession({ config, extensionSource: bundledSource }, async (session) => {
      await session.bindExtensions({ uiContext: confirmingUiContext(calls, true) as never });
      const result = await emitToolCall(session, "bash", { command: "echo hi" });
      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain("hard-deny-bash");
      expect(result?.reason).toContain("hard-deny");
      expect(result?.reason).not.toContain("ask-bash");
      expect(calls).toEqual([]);
    });
  }, 30_000);

  it("an allow in a second provider-config rule source cannot relax a hard-deny", async () => {
    const config = JSON.stringify({
      schemaVersion: 2,
      providers: [{
        id: "policy-engine",
        enabled: true,
        config: {
          rules: [
            { id: "hard-deny-bash", match: { tool: "bash" }, decision: "hard-deny", scope: "forbidden shell", remedy: "remove the prohibited action" },
          ],
          ruleSources: [{
            id: "project-layer",
            rules: [
              { id: "allow-bash", match: { tool: "bash" }, decision: "allow", scope: "project shell", remedy: "n/a" },
            ],
          }],
        },
      }],
    });
    await withPolicySession({ config, extensionSource: bundledSource }, async (session) => {
      const result = await emitToolCall(session, "bash", { command: "echo hi" });
      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain("hard-deny-bash");
      expect(result?.reason).toContain("hard-deny");
      expect(result?.reason).not.toContain("allow-bash");
    });
  }, 30_000);

  it("the full lattice outcome is deterministic under rule and object-key reordering", async () => {
    const configA = policyConfig([
      { id: "allow-bash", match: { tool: "bash" }, decision: "allow", scope: "shell", remedy: "n/a" },
      { id: "ask-bash", match: { tool: "bash" }, decision: "ask", scope: "shell", remedy: "request approval" },
      { id: "deny-bash", match: { tool: "bash" }, decision: "deny", scope: "shell", remedy: "use a read-only tool" },
      { id: "zz-hard-deny", match: { tool: "bash", input: { command: { equals: "echo hi" } } }, decision: "hard-deny", scope: "forbidden shell", remedy: "remove the prohibited action" },
      { id: "aa-hard-deny", match: { input: { command: { equals: "echo hi" } }, tool: "bash" }, decision: "hard-deny", scope: "forbidden shell", remedy: "remove the prohibited action" },
    ]);
    const configB = policyConfig([
      { remedy: "remove the prohibited action", decision: "hard-deny", match: { tool: "bash", input: { command: { equals: "echo hi" } } }, scope: "forbidden shell", id: "aa-hard-deny" },
      { match: { input: { command: { equals: "echo hi" } }, tool: "bash" }, id: "zz-hard-deny", remedy: "remove the prohibited action", scope: "forbidden shell", decision: "hard-deny" },
      { remedy: "use a read-only tool", scope: "shell", decision: "deny", match: { tool: "bash" }, id: "deny-bash" },
      { decision: "ask", remedy: "request approval", id: "ask-bash", scope: "shell", match: { tool: "bash" } },
      { scope: "shell", id: "allow-bash", remedy: "n/a", match: { tool: "bash" }, decision: "allow" },
    ]);

    const resultA = await withPolicySession({ config: configA, extensionSource: bundledSource }, async (session) =>
      emitToolCall(session, "bash", { command: "echo hi" }));
    const resultB = await withPolicySession({ config: configB, extensionSource: bundledSource }, async (session) =>
      emitToolCall(session, "bash", { command: "echo hi" }));

    expect(resultA).toMatchObject({ block: true });
    expect(resultA?.reason).toContain("aa-hard-deny");
    expect(resultA?.reason).toContain("hard-deny");
    expect(resultB).toEqual(resultA);
  }, 60_000);
});

describe("SLICE-0011 item 7: provider-tool parity", () => {
  it("gates a provider tool and a builtin tool with the same deny outcome at the scripted turn seam", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-parity-")), "marker.txt");
    const config = policyConfig(
      [{ id: "deny-tool-parity", match: { tool: ["marker", "read"] }, decision: "deny", scope: "tool parity", remedy: "use an allowed tool" }],
      [{ id: "marker-tools", enabled: true }],
    );

    await withPolicySession({ config, extensionSource: markerPolicySource(markerPath) }, async (session) => {
      expect(session.getAllTools().find((tool) => tool.name === "marker")?.sourceInfo.source).not.toBe("builtin");
      expect(session.getAllTools().find((tool) => tool.name === "read")?.sourceInfo.source).toBe("builtin");

      const providerResult = await runScriptedToolTurn(session, { name: "marker", arguments: { note: "blocked" } });
      const builtinResult = await runScriptedToolTurn(session, { name: "read", arguments: { path: hooksIndexPath } });

      expect(providerResult.isError).toBe(true);
      expect(builtinResult.isError).toBe(true);
      expect(await markerExecutions(markerPath)).toBe(0);

      const denialShape = /Policy Engine rule "([^"]+)" \(severity: ([^)]+)\) denies tool "[^"]+"/;
      const providerShape = providerResult.text.match(denialShape)?.slice(1);
      const builtinShape = builtinResult.text.match(denialShape)?.slice(1);
      expect(providerShape).toEqual(["deny-tool-parity", "deny"]);
      expect(builtinShape).toEqual(providerShape);
    });
  }, 30_000);
});

describe("SLICE-0011 item 8: agent-first policy messages", () => {
  const forbiddenEnforcementClaims = /OS[- ]level|OS containment|universal enforcement|universally enforced/i;

  it("surfaces a plain deny rule's id, scope, and concrete remedy in the model-visible result", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-message-")), "marker.txt");
    const config = policyConfig(
      [{
        id: "deny-sensitive-marker",
        match: { tool: "marker" },
        decision: "deny",
        scope: "sensitive marker writes",
        remedy: "use the read tool instead",
      }],
      [{ id: "marker-tools", enabled: true }],
    );

    await withPolicySession({ config, extensionSource: markerPolicySource(markerPath) }, async (session) => {
      const direct = await emitToolCall(session, "marker", { note: "blocked" });
      expect(direct).toMatchObject({ block: true });
      expect(direct?.reason).toContain("deny-sensitive-marker");
      expect(direct?.reason).toContain("severity: deny");

      const result = await runScriptedToolTurn(session, { name: "marker", arguments: { note: "blocked" } });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("deny-sensitive-marker");
      expect(result.text).toContain("sensitive marker writes");
      expect(result.text).toContain("use the read tool instead");
      expect(result.text).not.toMatch(forbiddenEnforcementClaims);
      expect(await markerExecutions(markerPath)).toBe(0);
    });
  }, 30_000);

  it("surfaces an unattended ask denial's id, scope, and concrete remedy in the model-visible result", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-message-")), "marker.txt");
    const config = policyConfig(
      [{
        id: "ask-sensitive-marker",
        match: { tool: "marker" },
        decision: "ask",
        scope: "elevated marker writes",
        remedy: "rerun with an attached UI and approve the prompt",
      }],
      [{ id: "marker-tools", enabled: true }],
    );

    await withPolicySession({ config, extensionSource: markerPolicySource(markerPath) }, async (session) => {
      const result = await runScriptedToolTurn(session, { name: "marker", arguments: { note: "blocked" } });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("ask-sensitive-marker");
      expect(result.text).toContain("elevated marker writes");
      expect(result.text).toContain("rerun with an attached UI and approve the prompt");
      expect(result.text).not.toMatch(forbiddenEnforcementClaims);
      expect(await markerExecutions(markerPath)).toBe(0);
    });
  }, 30_000);
});
