import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createHookHost, defineProvider, normalizeEvent } from "../src/index.js";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

async function withSession(
  config: string | undefined,
  source: string,
  run: (session: AgentSession, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-hooks-activation-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    if (config !== undefined) await writeFile(join(dir, "pi-hooks.jsonc"), config);
    await writeFile(join(dir, "extension.ts"), source);
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, additionalExtensionPaths: [join(dir, "extension.ts")],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({ cwd: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
    try { await run(session, dir); } finally { session.dispose(); }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

async function status(session: AgentSession) {
  const notices: string[] = [];
  await session.extensionRunner!.getCommand("hooks")!.handler("status", {
    ui: { notify: (text: string) => notices.push(text) },
  } as never);
  return JSON.parse(notices[0]);
}

const bare = `export { default } from ${JSON.stringify(entry)};`;

describe("ADR-001 activation at the real Pi boundary", () => {
  it("keeps the Bare Host active with missing configuration and passes bash unchanged", async () => {
    await withSession(undefined, bare, async (session) => {
      expect(await status(session)).toMatchObject({ activation: "active", providers: [], configuration: { health: "valid" } });
      const event = { type: "tool_call", toolName: "bash", toolCallId: "bare", input: { command: "echo unchanged" } };
      expect(await session.extensionRunner!.emitToolCall(event as never)).toBeUndefined();
      expect(event.input).toEqual({ command: "echo unchanged" });
    });
  });

  it("reports invalid JSONC and passes all tools unchanged without activating configured code", async () => {
    await withSession('{ "schemaVersion": ', bare, async (session) => {
      expect(await status(session)).toMatchObject({
        activation: "inactive", providers: [], configuration: { health: "invalid", lastFailure: expect.stringContaining("Invalid JSONC") },
      });
      for (const toolName of ["read", "bash", "write", "unknown"]) {
        const input = { command: "echo original", path: "x", content: "original" };
        const event = { type: "tool_call", toolName, toolCallId: toolName, input };
        expect(await session.extensionRunner!.emitToolCall(event as never)).toBeUndefined();
        expect(event.input).toEqual(input);
      }
    });
  });

  it("keeps policy an explicit composition rather than activating it through the Bare Host", async () => {
    const config = JSON.stringify({ schemaVersion: 2, providers: [{ id: "policy-engine", config: { rules: [
      { id: "no-shell", match: { tool: "bash" }, decision: "deny", scope: "shell", remedy: "use read" },
    ] } }] });
    await withSession(config, bare, async (session) => {
      expect((await status(session)).providers).toEqual([]);
      expect(await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "bare", input: { command: "echo ok" } } as never)).toBeUndefined();
    });
    const composed = `import { createPiHooksExtension, policyEngineProvider } from ${JSON.stringify(entry)};
      export default createPiHooksExtension({ providers: [policyEngineProvider] });`;
    await withSession(config, composed, async (session) => {
      expect((await status(session)).providers).toEqual([expect.objectContaining({ id: "policy-engine", enabled: true })]);
      expect(await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "policy", input: { command: "echo ok" } } as never)).toMatchObject({ block: true, reason: expect.stringContaining("no-shell") });
    });
  });

  it("rolls back every registration when a required Module is unavailable", async () => {
    const config = JSON.stringify({ schemaVersion: 2, modules: [{ id: "missing" }], providers: [{ id: "good" }] });
    const source = `import { Type } from "typebox";
      import { createPiHooksExtension, defineProvider } from ${JSON.stringify(entry)};
      export default createPiHooksExtension({ providers: [defineProvider({
        manifest: { id: "good", version: "1", grants: ["tools"] },
        activate(f) { f.tools.registerTool({ name: "rolled-back", label: "Probe", description: "probe", parameters: Type.Object({}), execute: async () => ({ content: [] }) }); }
      })] });`;
    await withSession(config, source, async (session) => {
      expect(session.getToolDefinition("rolled-back")).toBeUndefined();
      expect(await status(session)).toMatchObject({ activation: "inactive", configuration: { lastFailure: expect.stringContaining("missing") } });
    });
  });

  it("isolates an optional Module alias and a Provider alias before dispatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-event-validation-"));
    try {
      const configPath = join(dir, "pi-hooks.jsonc");
      await writeFile(configPath, JSON.stringify({ schemaVersion: 2, modules: [{ id: "legacy", required: false }], providers: [{ id: "legacy-provider", required: false }] }));
      const provider = defineProvider({ manifest: { id: "legacy-provider", version: "1", grants: ["events"] }, activate(f) {
        f.events.registerModule({ id: "legacy-contribution", PreToolUse: { guard() {} } } as never);
      } });
      const host = await createHookHost({ configPath, modules: [{ id: "legacy", Stop: { observe() {} } } as never], providers: [provider] });
      expect(host.status()).toMatchObject({ activation: "active", runtime: { health: "degraded", lastFailure: expect.stringContaining("agent_end") }, providers: [{ enabled: false, lastFailure: expect.stringContaining("tool_call") }] });
      expect(Object.values(host.status().phaseOrder).flat()).toEqual([]);
      expect(() => normalizeEvent("not-an-event", {})).toThrow("Use a native event");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses command execution during Provider activation before rollback", async () => {
    const config = JSON.stringify({ schemaVersion: 2, providers: [{ id: "early-process" }] });
    const source = `import { createPiHooksExtension, defineProvider } from ${JSON.stringify(entry)};
      export default createPiHooksExtension({ providers: [defineProvider({
        manifest: { id: "early-process", version: "1", grants: ["process"] },
        async activate(f) {
          await f.process.run({ command: process.execPath, args: ["-e", "require('fs').writeFileSync('escaped','yes')"], cwd: process.env.PI_CODING_AGENT_DIR, stdin: "{}", timeoutMs: 3000 });
          throw new Error("later activation failure");
        }
      })] });`;
    await withSession(config, source, async (session, dir) => {
      expect(await status(session)).toMatchObject({ activation: "inactive" });
      await expect(readFile(join(dir, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("keeps a denied call blocked when denial rendering cannot append an entry", async () => {
    const config = JSON.stringify({ schemaVersion: 2, modules: [{ id: "deny" }] });
    const source = `import { createPiHooksExtension } from ${JSON.stringify(entry)};
      export default async (pi) => {
        pi.appendEntry = () => { throw new Error("presentation unavailable"); };
        await createPiHooksExtension({ modules: [{ id: "deny", tool_call: { guard: () => ({ decision: "deny", reason: "must stay blocked" }) } }] })(pi);
      };`;
    await withSession(config, source, async (session) => {
      await session.bindExtensions({ uiContext: { notify() {}, setStatus() {} } as never });
      expect(await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "blocked", input: { command: "echo denied" } })).toMatchObject({ block: true, reason: "must stay blocked" });
    });
  });

  it("reports unreadable configuration separately from a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-unreadable-"));
    try {
      const host = await createHookHost({ configPath: dir });
      expect(host.status()).toMatchObject({ activation: "inactive", configuration: { lastFailure: expect.stringContaining("Cannot read trusted global configuration") } });
      for (const event of ["input", "tool_result", "context", "session_start", "session_shutdown"] as const) {
        expect(await host.dispatch(normalizeEvent(event, {}), { cwd: dir, hasUI: false })).toMatchObject({ event, decision: "allow" });
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not validate or activate an explicitly disabled Provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-disabled-"));
    try {
      const configPath = join(dir, "pi-hooks.jsonc");
      await writeFile(configPath, JSON.stringify({ schemaVersion: 2, providers: [{ id: "disabled", enabled: false }] }));
      const provider = defineProvider({ manifest: { id: "disabled", version: "", grants: ["events"] }, activate() { throw new Error("must not run"); } });
      const host = await createHookHost({ configPath, providers: [provider] });
      expect(host.status()).toMatchObject({ activation: "active", runtime: { health: "healthy" }, providers: [{ id: "disabled", enabled: false, health: "healthy" }] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each([true, false])("required=%s Provider failure controls the whole staged composition", async (required) => {
    const config = JSON.stringify({ schemaVersion: 2, providers: [{ id: "healthy" }, { id: "failed", required }] });
    const source = `
      import { Type } from "typebox";
      import { join } from "node:path";
      import { createPiHooksExtension, defineProvider } from ${JSON.stringify(entry)};
      const healthy = defineProvider({
        manifest: { id: "healthy", version: "1", grants: ["tools", "commands", "events", "process", "ui"] },
        activate(f) {
          f.tools.registerTool({ name: "probe", label: "Probe", description: "probe", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ran" }] }) });
          f.commands.registerCommand("probe-command", { description: "probe", handler: async () => {} });
          f.events.registerModule({ id: "probe-event", tool_call: { transform: () => ({ input: { changed: true } }) } });
          f.process.spawn({ id: "probe-process", command: process.execPath, args: ["-e", "require('fs').writeFileSync(process.argv[1], 'ran')", join(process.env.PI_CODING_AGENT_DIR, "process.txt")] });
          f.ui.setStatus("probe-status", "active");
        }
      });
      const failed = defineProvider({ manifest: { id: "failed", version: "1", grants: ["events"] }, activate() { throw new Error("required startup failure"); } });
      export default createPiHooksExtension({ providers: [healthy, failed] });
    `;
    await withSession(config, source, async (session, dir) => {
      const report = await status(session);
      expect(report.activation).toBe(required ? "inactive" : "active");
      expect(report.runtime).toMatchObject({ health: "degraded", lastFailure: expect.stringContaining("failed") });
      expect(Boolean(session.getToolDefinition("probe"))).toBe(!required);
      expect(Boolean(session.extensionRunner!.getCommand("probe-command"))).toBe(!required);
      const input: Record<string, unknown> = { command: "echo unchanged" };
      await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "rollback", input } as never);
      expect(input).toEqual(required ? { command: "echo unchanged" } : { changed: true });
      if (required) {
        const uiCalls: unknown[] = [];
        await session.bindExtensions({ uiContext: { setStatus: (...args: unknown[]) => uiCalls.push(args) } as never });
        expect(uiCalls).toEqual([]);
        expect(report.providers.every((provider: { enabled: boolean }) => !provider.enabled)).toBe(true);
        expect(Object.values(report.phaseOrder).flat()).toEqual([]);
        await expect(readFile(join(dir, "process.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  });
});
