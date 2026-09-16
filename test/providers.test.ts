import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createHookHost, defineProvider, normalizeEvent } from "../src/index.js";
import { loadGlobalConfig } from "../src/config.js";

const hooksIndexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

async function withProviderSession<T>(
  options: { config: string; extensionSource: string },
  run: (session: AgentSession, agentDir: string) => Promise<T>,
): Promise<T> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-hooks-providers-"));
  await writeFile(join(agentDir, "pi-hooks.jsonc"), options.config);
  const extraPath = join(agentDir, "provider-extension.ts");
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
      return await run(session, agentDir);
    } finally {
      session.dispose();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

/** A globally authorized provider declaring the tools grant registers a real Pi tool. */
function toolProviderSource(markerPath: string): string {
  return `
import { Type } from "typebox";
import { writeFile } from "node:fs/promises";
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};

const greeter = defineProvider({
  manifest: { id: "greeter", version: "1.0.0", grants: ["tools"] },
  activate(facade) {
    facade.tools.registerTool({
      name: "greet",
      label: "Greet",
      description: "Writes a greeting marker to prove provider tool execution",
      parameters: Type.Object({ who: Type.String() }),
      async execute(_id, params) {
        await writeFile(${JSON.stringify(markerPath)}, "greeted:" + params.who);
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
  },
});

export default createPiHooksExtension({ providers: [greeter] });
`;
}

/** A provider without the tools grant that casts around the type and calls registerTool anyway. */
function ungrantedToolSource(): string {
  return `
import { Type } from "typebox";
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};

const sneaky = defineProvider({
  manifest: { id: "sneaky", version: "1.0.0", grants: ["events"] },
  activate(facade) {
    // Dynamically-loaded providers can cast around the type boundary; the Host
    // must back the type refusal at runtime.
    (facade as any).tools.registerTool({
      name: "sneaky-tool",
      label: "Sneaky",
      description: "should never be registered",
      parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text", text: "no" }] }; },
    });
  },
});

export default createPiHooksExtension({ providers: [sneaky] });
`;
}

describe("SLICE-0009 AC1: tools grant registration and refusal at the real seam", () => {
  it("registers and executes a provider tool when the tools grant is declared", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-marker-")), "greet.txt");
    const config = JSON.stringify({ schemaVersion: 2, providers: [{ id: "greeter", enabled: true }] });
    await withProviderSession({ config, extensionSource: toolProviderSource(markerPath) }, async (session) => {
      const info = session.getAllTools().find((tool) => tool.name === "greet");
      expect(info).toBeDefined();
      expect(info?.sourceInfo.source).not.toBe("builtin");

      const def = session.getToolDefinition("greet");
      expect(def).toBeDefined();
      await def!.execute("call-1", { who: "world" } as never, undefined, undefined, {} as never);
      expect(await readFile(markerPath, "utf8")).toBe("greeted:world");
    });
  }, 30_000);

  it("refuses an undeclared tools grant at runtime with an audited provider-attributed refusal", async () => {
    const auditDir = await mkdtemp(join(tmpdir(), "pi-hooks-refuse-audit-"));
    const auditPath = join(auditDir, "audit.jsonl");
    const config = JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "sneaky", enabled: true }],
      audit: { path: auditPath, includeAllows: false },
    });
    await withProviderSession({ config, extensionSource: ungrantedToolSource() }, async (session) => {
      // The tool never reaches Pi's registry.
      expect(session.getAllTools().find((tool) => tool.name === "sneaky-tool")).toBeUndefined();
      expect(session.getToolDefinition("sneaky-tool")).toBeUndefined();

      const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const refusal = lines.find((line) => line.decision === "grant-refused");
      expect(refusal).toBeDefined();
      expect(refusal.provider).toBe("sneaky");
    });
  }, 30_000);
});

/** A valid provider and a config-schema-invalid provider loaded together. */
function mixedValiditySource(markerPath: string): string {
  return `
import { Type } from "typebox";
import { writeFile } from "node:fs/promises";
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};

const good = defineProvider({
  manifest: { id: "good", version: "1.0.0", grants: ["tools"] },
  activate(facade) {
    facade.tools.registerTool({
      name: "good-tool",
      label: "Good",
      description: "registered by the healthy provider",
      parameters: Type.Object({}),
      async execute() {
        await writeFile(${JSON.stringify(markerPath)}, "good-ran");
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
  },
});

const badConfig = defineProvider({
  manifest: {
    id: "bad-config",
    version: "1.0.0",
    grants: ["tools"],
    configSchema: Type.Object({ threshold: Type.Number() }),
  },
  activate(facade, config) {
    facade.tools.registerTool({
      name: "bad-config-tool",
      label: "Bad",
      description: "must never be registered because config is invalid",
      parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text", text: "no" }] }; },
    });
  },
});

export default createPiHooksExtension({ providers: [good, badConfig] });
`;
}

describe("SLICE-0009 AC2: manifest and config-schema validation isolates a provider", () => {
  it("isolates a config-schema-invalid provider while its sibling stays healthy at the real seam", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-good-")), "good.txt");
    const auditDir = await mkdtemp(join(tmpdir(), "pi-hooks-manifest-audit-"));
    const auditPath = join(auditDir, "audit.jsonl");
    const config = JSON.stringify({
      schemaVersion: 2,
      providers: [
        { id: "good", enabled: true },
        { id: "bad-config", enabled: true, required: false, config: { threshold: "not-a-number" } },
      ],
      audit: { path: auditPath },
    });
    await withProviderSession({ config, extensionSource: mixedValiditySource(markerPath) }, async (session) => {
      // Sibling is unaffected: its tool registered and executes.
      const good = session.getToolDefinition("good-tool");
      expect(good).toBeDefined();
      await good!.execute("call-1", {} as never, undefined, undefined, {} as never);
      expect(await readFile(markerPath, "utf8")).toBe("good-ran");

      // Invalid provider isolated: never activated, tool absent.
      expect(session.getToolDefinition("bad-config-tool")).toBeUndefined();

      const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const failure = lines.find((line) => line.provider === "bad-config" && line.decision === "module-failure");
      expect(failure).toBeDefined();
    });
  }, 30_000);

  it("degrades runtime health on an invalid manifest while configuration stays valid and normal (detached)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-manifest-status-"));
    const configPath = join(dir, "pi-hooks.jsonc");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 2,
      providers: [
        { id: "healthy", enabled: true },
        { id: "broken", enabled: true, required: false },
      ],
    }));
    const healthy = defineProvider({
      manifest: { id: "healthy", version: "1.0.0", grants: ["events"] },
      activate() {},
    });
    // Structurally invalid manifest: a dynamically loaded provider missing its version.
    const broken = defineProvider({
      manifest: { id: "broken", version: "", grants: ["events"] },
      activate() {},
    });
    const host = await createHookHost({ configPath, providers: [healthy, broken] });
    const status = host.status();
    // Optional Provider failure leaves the Host active and degrades runtime health.
    expect(status.runtime.health).toBe("degraded");
    expect(status.configuration.health).toBe("valid");
    expect(status.activation).toBe("active");
  });
});

function recordingUiContext(sink: Array<[string, string | undefined]>): unknown {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => undefined,
    onTerminalInput: () => () => undefined,
    setStatus: (key: string, text: string | undefined) => sink.push([key, text]),
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("SLICE-0009 AC3: every grant kind maps to a real Pi effect", () => {
  it("events grant: a provider Hook Module denies a tool at the real tool_call seam", async () => {
    const source = `
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};
const denier = defineProvider({
  manifest: { id: "denier", version: "1.0.0", grants: ["events"] },
  activate(facade) {
    facade.events.registerModule({
      id: "denier-mod",
      tool_call: { guard: ({ event }) => (event.toolName === "bash" ? { decision: "deny", reason: "events grant denied bash" } : undefined) },
    });
  },
});
export default createPiHooksExtension({ providers: [denier] });
`;
    const config = JSON.stringify({ schemaVersion: 2, providers: [{ id: "denier", enabled: true }] });
    await withProviderSession({ config, extensionSource: source }, async (session) => {
      const result = await session.extensionRunner!.emitToolCall({
        type: "tool_call", toolName: "bash", toolCallId: "e1", input: { command: "echo hi" },
      } as never);
      expect(result).toMatchObject({ block: true, reason: expect.stringContaining("events grant denied bash") });
    });
  }, 30_000);

  it("commands grant: a provider slash command executes at the real seam", async () => {
    const marker = join(await mkdtemp(join(tmpdir(), "pi-hooks-cmd-")), "cmd.marker");
    const source = `
import { writeFile } from "node:fs/promises";
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};
const cmd = defineProvider({
  manifest: { id: "cmder", version: "1.0.0", grants: ["commands"] },
  activate(facade) {
    facade.commands.registerCommand("greetcmd", {
      description: "provider command",
      handler: async () => { await writeFile(${JSON.stringify(marker)}, "cmd-ran"); },
    });
  },
});
export default createPiHooksExtension({ providers: [cmd] });
`;
    const config = JSON.stringify({ schemaVersion: 2, providers: [{ id: "cmder", enabled: true }] });
    await withProviderSession({ config, extensionSource: source }, async (session) => {
      await session.prompt("/greetcmd");
      expect(await readFile(marker, "utf8")).toBe("cmd-ran");
    });
  }, 30_000);

  it("process grant: Host defers start to session_start and kills at session_shutdown with no orphan", async () => {
    const pidFile = join(await mkdtemp(join(tmpdir(), "pi-hooks-proc-")), "child.pid");
    const source = `
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};
const script = "const fs=require('fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{}, 10000);";
const proc = defineProvider({
  manifest: { id: "procer", version: "1.0.0", grants: ["process"] },
  activate(facade) {
    facade.process.spawn({ id: "worker", command: "node", args: ["-e", script, ${JSON.stringify(pidFile)}] });
  },
});
export default createPiHooksExtension({ providers: [proc] });
`;
    const config = JSON.stringify({ schemaVersion: 2, providers: [{ id: "procer", enabled: true }] });
    await withProviderSession({ config, extensionSource: source }, async (session) => {
      // Deferred: not started merely by loading. Start on session_start.
      await session.extensionRunner!.emit({ type: "session_start", reason: "startup" } as never);
      expect(await waitFor(async () => { try { await readFile(pidFile, "utf8"); return true; } catch { return false; } })).toBe(true);
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(isAlive(pid)).toBe(true);

      await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" } as never);
      expect(await waitFor(() => !isAlive(pid))).toBe(true);
    });
  }, 30_000);

  it("ui grant: a provider status reaches the real ctx.ui on session_start", async () => {
    const source = `
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};
const widgeter = defineProvider({
  manifest: { id: "uier", version: "1.0.0", grants: ["ui"] },
  activate(facade) { facade.ui.setStatus("uier:diagnostics", "3 warnings"); },
});
export default createPiHooksExtension({ providers: [widgeter] });
`;
    const config = JSON.stringify({ schemaVersion: 2, providers: [{ id: "uier", enabled: true }] });
    const statuses: Array<[string, string | undefined]> = [];
    await withProviderSession({ config, extensionSource: source }, async (session) => {
      await session.bindExtensions({ uiContext: recordingUiContext(statuses) as never });
      await session.extensionRunner!.emit({ type: "session_start", reason: "startup" } as never);
      expect(statuses).toContainEqual(["uier:diagnostics", "3 warnings"]);
    });
  }, 30_000);
});

describe("SLICE-0009 AC4: schemaVersion 2 migration and Inactive Host", () => {
  it("migrates a schemaVersion 1 file to v2 with an empty providers section, preserving modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-migrate-"));
    const path = join(dir, "pi-hooks.jsonc");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, modules: [{ id: "legacy", enabled: true }] }));
    const config = await loadGlobalConfig(path);
    expect(config.schemaVersion).toBe(2);
    expect(config.providers).toEqual([]);
    expect(config.modules).toEqual([{ id: "legacy", enabled: true }]);
  });

  it("accepts a native schemaVersion 2 file with a providers section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-v2-"));
    const path = join(dir, "pi-hooks.jsonc");
    await writeFile(path, JSON.stringify({ schemaVersion: 2, providers: [{ id: "p", enabled: true }] }));
    const config = await loadGlobalConfig(path);
    expect(config.schemaVersion).toBe(2);
    expect(config.providers).toEqual([{ id: "p", enabled: true }]);
    expect(config.modules).toEqual([]);
  });

  it("rejects an unsupported schemaVersion with a precise error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-badver-"));
    const path = join(dir, "pi-hooks.jsonc");
    await writeFile(path, JSON.stringify({ schemaVersion: 3, modules: [] }));
    await expect(loadGlobalConfig(path)).rejects.toThrow(/schemaVersion/);
  });

  it("keeps an unsupported-version global config in Read-Only Safe Mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-safe-"));
    const path = join(dir, "pi-hooks.jsonc");
    await writeFile(path, JSON.stringify({ schemaVersion: 3 }));
    const host = await createHookHost({ configPath: path });
    expect(host.status().activation).toBe("inactive");
    expect(host.status().configuration.health).toBe("invalid");
  });
});

describe("SLICE-0009 AC5: status lists providers and audit carries provider attribution", () => {
  it("lists every provider with source, declared grants, and per-provider health (detached status)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-status-"));
    const configPath = join(dir, "pi-hooks.jsonc");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "healthy", enabled: true }, { id: "broken", enabled: true, required: false }],
    }));
    const healthy = defineProvider({
      manifest: { id: "healthy", version: "1.0.0", grants: ["events"] },
      activate() {},
    });
    const broken = defineProvider({
      manifest: { id: "broken", version: "", grants: ["events"] },
      activate() {},
    });
    const host = await createHookHost({ configPath, providers: [healthy, broken] });
    const providers = host.status().providers;
    expect(providers.map((p) => p.id).sort()).toEqual(["broken", "healthy"]);
    expect(providers.find((p) => p.id === "healthy")).toMatchObject({
      source: "global",
      grants: ["events"],
      health: "healthy",
    });
    expect(providers.find((p) => p.id === "broken")?.health).toBe("degraded");
  });

  it("attributes a provider events-module runtime failure to its provider in the audit log", async () => {
    const auditDir = await mkdtemp(join(tmpdir(), "pi-hooks-attrib-audit-"));
    const auditPath = join(auditDir, "audit.jsonl");
    const source = `
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};
const flaky = defineProvider({
  manifest: { id: "flaky-provider", version: "1.0.0", grants: ["events"] },
  activate(facade) {
    facade.events.registerModule({
      id: "flaky-mod",
      tool_call: { guard: () => { throw new Error("flaky module exploded"); } },
    });
  },
});
export default createPiHooksExtension({ providers: [flaky] });
`;
    const config = JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "flaky-provider", enabled: true, required: false }],
      audit: { path: auditPath },
    });
    await withProviderSession({ config, extensionSource: source }, async (session) => {
      await session.extensionRunner!.emitToolCall({
        type: "tool_call", toolName: "bash", toolCallId: "a1", input: { command: "echo hi" },
      } as never);
      const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const failure = lines.find((line) => line.decision === "module-failure" && line.provider === "flaky-provider");
      expect(failure).toBeDefined();
    });
  }, 30_000);
});

describe("SLICE-0009 review repair regressions", () => {
  it("R1a process grant: kills the whole process tree at shutdown (no orphaned grandchild)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-tree-"));
    const parentPid = join(dir, "parent.pid");
    const grandPid = join(dir, "grand.pid");
    const gcScript = "const fs=require('fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},10000);";
    const script = "const {spawn}=require('child_process'); const fs=require('fs');"
      + " fs.writeFileSync(process.argv[1], String(process.pid));"
      + " spawn('node',['-e'," + JSON.stringify(gcScript) + ",process.argv[2]],{stdio:'ignore'});"
      + " setInterval(()=>{},10000);";
    const source = `
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};
const proc = defineProvider({
  manifest: { id: "tree", version: "1.0.0", grants: ["process"] },
  activate(facade) {
    facade.process.spawn({ id: "tree", command: "node", args: ["-e", ${JSON.stringify(script)}, ${JSON.stringify(parentPid)}, ${JSON.stringify(grandPid)}] });
  },
});
export default createPiHooksExtension({ providers: [proc] });
`;
    const config = JSON.stringify({ schemaVersion: 2, providers: [{ id: "tree", enabled: true }] });
    await withProviderSession({ config, extensionSource: source }, async (session) => {
      await session.extensionRunner!.emit({ type: "session_start", reason: "startup" } as never);
      expect(await waitFor(async () => { try { await readFile(grandPid, "utf8"); return true; } catch { return false; } })).toBe(true);
      const parent = Number((await readFile(parentPid, "utf8")).trim());
      const grand = Number((await readFile(grandPid, "utf8")).trim());
      expect(isAlive(parent)).toBe(true);
      expect(isAlive(grand)).toBe(true);
      await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" } as never);
      expect(await waitFor(() => !isAlive(parent) && !isAlive(grand))).toBe(true);
    });
  }, 30_000);

  it("R1c process grant: reaps a grandchild when the leader exits early (daemonize-then-exit)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-earlyexit-"));
    const grandPid = join(dir, "grand.pid");
    const configPath = join(dir, "pi-hooks.jsonc");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, providers: [{ id: "early", enabled: true }] }));
    const gc = "const fs=require('fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},10000);";
    // The leader spawns a same-group grandchild, then exits on its own.
    const script = "const {spawn}=require('child_process'); spawn('node',['-e'," + JSON.stringify(gc)
      + ",process.argv[1]],{stdio:'ignore'}); setTimeout(()=>process.exit(0), 200);";
    const early = defineProvider({
      manifest: { id: "early", version: "1.0.0", grants: ["process"] },
      activate(facade) { facade.process.spawn({ id: "early", command: "node", args: ["-e", script, grandPid] }); },
    });
    const host = await createHookHost({ configPath, providers: [early] });
    await host.dispatch(normalizeEvent("session_start", { reason: "startup" }), { cwd: dir, hasUI: false } as never);
    expect(await waitFor(async () => { try { await readFile(grandPid, "utf8"); return true; } catch { return false; } })).toBe(true);
    const grand = Number((await readFile(grandPid, "utf8")).trim());
    // The leader exits ~200ms in; its exit handler reaps the surviving grandchild.
    expect(await waitFor(() => !isAlive(grand), 4000)).toBe(true);
  }, 30_000);

  it("R1b process grant: a spawn error (ENOENT) degrades the provider instead of being swallowed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-enoent-"));
    const configPath = join(dir, "pi-hooks.jsonc");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, providers: [{ id: "badproc", enabled: true }] }));
    const badproc = defineProvider({
      manifest: { id: "badproc", version: "1.0.0", grants: ["process"] },
      activate(facade) { facade.process.spawn({ id: "nope", command: "definitely-not-a-real-binary-xyz" }); },
    });
    const host = await createHookHost({ configPath, providers: [badproc] });
    await host.dispatch(normalizeEvent("session_start", { reason: "startup" }), { cwd: dir, hasUI: false } as never);
    expect(await waitFor(() => host.status().runtime.health === "degraded")).toBe(true);
    expect(host.status().providers.find((p) => p.id === "badproc")?.health).toBe("degraded");
  }, 30_000);

  it("R2 transactional activation: a provider that registers then throws leaves nothing registered", async () => {
    const auditDir = await mkdtemp(join(tmpdir(), "pi-hooks-rollback-audit-"));
    const auditPath = join(auditDir, "audit.jsonl");
    const source = `
import { Type } from "typebox";
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};
const halfBaked = defineProvider({
  manifest: { id: "half", version: "1.0.0", grants: ["tools"] },
  activate(facade) {
    facade.tools.registerTool({
      name: "half-tool", label: "Half", description: "registered before the throw",
      parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text", text: "no" }] }; },
    });
    throw new Error("activation blew up after registering");
  },
});
export default createPiHooksExtension({ providers: [halfBaked] });
`;
    const config = JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "half", enabled: true }],
      audit: { path: auditPath },
    });
    await withProviderSession({ config, extensionSource: source }, async (session) => {
      // Rollback: the tool staged before the throw was never committed to Pi.
      expect(session.getToolDefinition("half-tool")).toBeUndefined();
      const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(lines.find((line) => line.provider === "half" && line.decision === "module-failure")).toBeDefined();
    });
  }, 30_000);

  it("R3 malformed manifest: a throwing-getter provider isolates without aborting a valid sibling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-malformed-"));
    const configPath = join(dir, "pi-hooks.jsonc");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "garbage", enabled: true, required: false }, { id: "good", enabled: true }],
    }));
    // A dynamically-loaded provider whose manifest.grants getter throws.
    const garbage = {
      manifest: { id: "garbage", version: "1.0.0", get grants() { throw new Error("boom"); } },
      activate() {},
    } as never;
    const good = defineProvider({
      manifest: { id: "good", version: "1.0.0", grants: ["events"] },
      activate(facade) { facade.events.registerModule({ id: "good-mod", agent_end: { observe: () => undefined } }); },
    });
    const host = await createHookHost({ configPath, providers: [garbage, good] });
    const providers = host.status().providers;
    expect(providers.find((p) => p.id === "garbage")?.health).toBe("degraded");
    expect(providers.find((p) => p.id === "good")?.health).toBe("healthy");
  });

  it("R5 provider runtime module failure degrades that provider's health", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-runhealth-"));
    const configPath = join(dir, "pi-hooks.jsonc");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "flaky", enabled: true, required: false }],
    }));
    const flaky = defineProvider({
      manifest: { id: "flaky", version: "1.0.0", grants: ["events"] },
      activate(facade) {
        facade.events.registerModule({
          id: "flaky-mod",
          tool_call: { guard: () => { throw new Error("runtime boom"); } },
        });
      },
    });
    const host = await createHookHost({ configPath, providers: [flaky] });
    expect(host.status().providers.find((p) => p.id === "flaky")?.health).toBe("healthy");
    await host.dispatch(
      normalizeEvent("tool_call", { toolName: "bash", toolCallId: "r5", input: { command: "echo" } }),
      { cwd: dir, hasUI: false } as never,
    );
    expect(host.status().providers.find((p) => p.id === "flaky")?.health).toBe("degraded");
  });
});
