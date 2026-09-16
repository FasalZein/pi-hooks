import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createHookHost,
  createPiHooksExtension,
  normalizeEvent,
  type HookModule,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const validConfig = (modules: string[] = []) => JSON.stringify({
  schemaVersion: 1,
  modules: modules.map((id) => ({ id, enabled: true })),
});

async function fixture(config: string) {
  const dir = await mkdtemp(join(tmpdir(), "pi-hooks-"));
  const configPath = join(dir, "pi-hooks.jsonc");
  const auditPath = join(dir, "audit.jsonl");
  await writeFile(configPath, config);
  return { configPath, auditPath };
}

type TestHandler = (...args: unknown[]) => unknown;

function fakePi() {
  const handlers = new Map<string, TestHandler>();
  const commands = new Map<string, { handler: TestHandler }>();
  const registrations: string[] = [];
  return {
    api: {
      on(name: string, handler: TestHandler) { handlers.set(name, handler); },
      registerCommand(name: string, command: { handler: TestHandler }) {
        registrations.push(`command:${name}`);
        commands.set(name, command);
      },
      registerTool() { registrations.push("tool"); },
      getAllTools() { return []; },
      getActiveTools() { return []; },
    },
    handlers,
    commands,
    registrations,
  };
}

const ctx = {
  cwd: "/workspace",
  hasUI: false,
  sessionManager: {
    getSessionFile: () => "/sessions/test.jsonl",
    getSessionId: () => "session-1",
  },
  ui: { notify: () => undefined },
};

describe("Hook Host dispatch and Pi adapter", () => {
  it("loads through Pi 0.85.1 public SDK APIs without tools or prompt additions", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-hooks-agent-"));
    await writeFile(join(agentDir, "pi-hooks.jsonc"), validConfig());
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    try {
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({ resourceLoader: loader, sessionManager: SessionManager.inMemory() });
      try {
        expect(session.getAllTools().every((tool) => tool.sourceInfo.source === "builtin")).toBe(true);
        expect(loader.getAppendSystemPrompt()).toEqual([]);
      } finally {
        session.dispose();
      }
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("loads a clean packed managed install with peer installation disabled", async () => {
    const installDir = await mkdtemp(join(tmpdir(), "pi-hooks-packed-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-hooks-packed-agent-"));
    await writeFile(join(agentDir, "pi-hooks.jsonc"), validConfig());
    const { stdout } = await execFileAsync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", installDir], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
    const [{ filename }] = JSON.parse(stdout) as Array<{ filename: string }>;
    await execFileAsync("npm", ["install", join(installDir, filename), "--ignore-scripts", "--legacy-peer-deps", "--omit=peer", "--no-audit", "--no-fund"], {
      cwd: installDir,
    });
    const packageDir = join(installDir, "node_modules", "@tothemoon", "pi-hooks");
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    expect(manifest.dependencies).toMatchObject({ "jsonc-parser": "3.3.1", typebox: "1.1.38" });
    expect(JSON.parse(await readFile(join(installDir, "node_modules", "typebox", "package.json"), "utf8")).version).toBe("1.1.38");
    const loader = new DefaultResourceLoader({
      cwd: installDir,
      agentDir,
      additionalExtensionPaths: [join(packageDir, "src", "index.ts")],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
  }, 30_000);

  it("exercises bare typebox, typebox/compile, and typebox/value through Pi loader aliases with no repository fallback", async () => {
    const installDir = await mkdtemp(join(tmpdir(), "pi-hooks-alias-"));
    const { stdout } = await execFileAsync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", installDir], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
    const [{ filename }] = JSON.parse(stdout) as Array<{ filename: string }>;
    await execFileAsync("npm", ["install", join(installDir, filename), "--ignore-scripts", "--legacy-peer-deps", "--omit=peer", "--no-audit", "--no-fund"], {
      cwd: installDir,
    });
    const packageDir = join(installDir, "node_modules", "@tothemoon", "pi-hooks");

    // The trusted configuration module pins the exact Pi-managed TypeBox trio.
    const configSource = await readFile(join(packageDir, "src", "config.ts"), "utf8");
    expect(configSource).toContain('from "typebox";');
    expect(configSource).toContain('from "typebox/compile";');
    expect(configSource).toContain('from "typebox/value";');

    // Remove the installed typebox copy: every typebox import must resolve
    // through Pi 0.85.1 loader aliases; tmpdir offers no repository fallback.
    await rm(join(installDir, "node_modules", "typebox"), { recursive: true, force: true });

    const loadSession = async (config: string) => {
      const agentDir = await mkdtemp(join(tmpdir(), "pi-hooks-alias-agent-"));
      await writeFile(join(agentDir, "pi-hooks.jsonc"), config);
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        const loader = new DefaultResourceLoader({
          cwd: installDir,
          agentDir,
          additionalExtensionPaths: [join(packageDir, "src", "index.ts")],
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        });
        await loader.reload();
        expect(loader.getExtensions().errors).toEqual([]);
        const { session } = await createAgentSession({ resourceLoader: loader, sessionManager: SessionManager.inMemory() });
        return session;
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    };

    // Valid config: the compiled checker (typebox/compile) accepts through the alias path.
    const healthy = await loadSession(JSON.stringify({ schemaVersion: 1, modules: [] }));
    try {
      const allowed = await healthy.extensionRunner!.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "alias-ok",
        input: { command: "echo hi" },
      } as never);
      expect(allowed).toBeUndefined();
    } finally {
      healthy.dispose();
    }

    // ADR-001: schema errors leave an inspectable Inactive Host, not a fallback policy.
    const inactive = await loadSession(JSON.stringify({ schemaVersion: 3, modules: [] }));
    try {
      const result = await inactive.extensionRunner!.emitToolCall({
        type: "tool_call",
        toolName: "write",
        toolCallId: "alias-bad",
        input: { path: "x", content: "y" },
      } as never);
      expect(result).toBeUndefined();
      const notices: string[] = [];
      await inactive.extensionRunner!.getCommand("hooks")!.handler("status", { ui: { notify: (text: string) => notices.push(text) } } as never);
      expect(JSON.parse(notices[0])).toMatchObject({ activation: "inactive", configuration: { lastFailure: expect.stringContaining("Schema validation failed") } });
    } finally {
      inactive.dispose();
    }
  }, 60_000);

  it("traverses the complete guard → transform → internal-final → context → observe path", async () => {
    const seen: string[] = [];
    const module: HookModule = {
      id: "tracer",
      tool_call: {
        guard: () => { seen.push("guard"); },
        transform: ({ input }) => { seen.push("transform"); return { input: { ...input, traced: true } }; },
        internalFinal: ({ input }) => { seen.push(`internal-final:${input.traced}`); },
        context: () => { seen.push("context"); return { context: "hidden tracer context" }; },
        observe: ({ decision, contextAdditions }) => { seen.push(`observe:${decision}:${contextAdditions.length}`); },
      },
    };
    const { configPath } = await fixture(validConfig(["tracer"]));
    const host = await createHookHost({ configPath, modules: [module] });
    const result = await host.dispatch(normalizeEvent("tool_call", {
      toolName: "read",
      toolCallId: "trace",
      input: { path: "x" },
    }), ctx as never);

    expect(result).toMatchObject({ decision: "allow", input: { path: "x", traced: true }, contextAdditions: ["hidden tracer context"] });
    expect(seen).toEqual(["guard", "transform", "internal-final:true", "context", "observe:allow:1"]);
  });

  it("runs internal-final after transforms and blocks transformed input", async () => {
    const seen: string[] = [];
    const module: HookModule = {
      id: "policy",
      tool_call: {
        guard: ({ input }) => { seen.push(`guard:${input.command}`); },
        transform: ({ input }) => {
          seen.push(`transform:${input.command}`);
          return { input: { ...input, command: "denied" } };
        },
        internalFinal: ({ input }) => {
          seen.push(`internal-final:${input.command}`);
          if (input.command === "denied") return { decision: "deny", reason: "transformed input denied" };
        },
        context: () => { seen.push("context"); return { context: "hidden" }; },
        observe: ({ decision }) => { seen.push(`observe:${decision}`); },
      },
    };
    const { configPath } = await fixture(validConfig(["policy"]));
    const pi = fakePi();
    await createPiHooksExtension({ configPath, modules: [module] })(pi.api as never);

    const input = { command: "allowed" };
    const result = await pi.handlers.get("tool_call")?.(
      { type: "tool_call", toolName: "bash", toolCallId: "call-1", input },
      ctx,
    );

    expect(result).toEqual({ block: true, reason: "transformed input denied" });
    expect(input).toEqual({ command: "denied" });
    expect(seen).toEqual([
      "guard:allowed",
      "transform:allowed",
      "internal-final:denied",
      "observe:deny",
    ]);
  });

  it("returns Host mutation through the ordinary tool_call path", async () => {
    const module: HookModule = {
      id: "rewrite",
      tool_call: {
        transform: () => ({ input: { command: "echo safe", removed: undefined } }),
      },
    };
    const { configPath } = await fixture(validConfig(["rewrite"]));
    const pi = fakePi();
    await createPiHooksExtension({ configPath, modules: [module] })(pi.api as never);
    const input: Record<string, unknown> = { command: "echo unsafe", stale: true };

    const result = await pi.handlers.get("tool_call")?.(
      { type: "tool_call", toolName: "bash", toolCallId: "call-2", input },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(input).toEqual({ command: "echo safe", removed: undefined });
  });
});

describe("ordering and effective policy validation", () => {
  it("orders phase handlers deterministically with before/after dependencies", async () => {
    const seen: string[] = [];
    const modules: HookModule[] = [
      { id: "c", after: ["b"], tool_call: { guard: () => { seen.push("c"); } } },
      { id: "a", before: ["b"], tool_call: { guard: () => { seen.push("a"); } } },
      { id: "b", tool_call: { guard: () => { seen.push("b"); } } },
    ];
    const { configPath } = await fixture(validConfig(["c", "a", "b"]));
    const host = await createHookHost({ configPath, modules });
    await host.dispatch(normalizeEvent("tool_call", { toolName: "read", toolCallId: "1", input: { path: "x" } }), ctx as never);
    expect(seen).toEqual(["a", "b", "c"]);
    expect(host.status().phaseOrder.guard).toEqual(["a", "b", "c"]);
  });

  it("sources requiredness from trusted global config: missing optional degrades, missing required makes the Host inactive", async () => {
    const optionalMissing = await fixture(JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "present", enabled: true }, { id: "ghost", enabled: true, required: false }],
    }));
    const degradedHost = await createHookHost({
      configPath: optionalMissing.configPath,
      modules: [{ id: "present", tool_call: { guard: () => undefined } }],
    });
    const status = degradedHost.status();
    expect(status.activation).toBe("active");
    expect(status.configuration.health).toBe("valid");
    expect(status.runtime).toMatchObject({ health: "degraded", lastFailure: expect.stringContaining("ghost") });
    expect(status.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "present", enabled: true, required: true }),
      expect.objectContaining({ id: "ghost", enabled: false, required: false }),
    ]));
    const dispatched = await degradedHost.dispatch(
      normalizeEvent("tool_call", { toolName: "bash", toolCallId: "opt", input: { command: "echo hi" } }),
      ctx as never,
    );
    expect(dispatched.decision).toBe("allow");

    const requiredMissing = await fixture(JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "ghost", enabled: true }],
    }));
    const safeHost = await createHookHost({ configPath: requiredMissing.configPath, modules: [] });
    expect(safeHost.status()).toMatchObject({
      activation: "inactive",
      configuration: { health: "invalid", lastFailure: expect.stringContaining("ghost") },
    });
  });

  it("rejects duplicate available module ids before any lookup can collapse them", async () => {
    const { configPath } = await fixture(validConfig(["dup"]));
    const host = await createHookHost({
      configPath,
      modules: [
        { id: "dup", tool_call: { guard: () => undefined } },
        { id: "dup", tool_call: { internalFinal: () => ({ decision: "deny", reason: "impostor collapsed in" }) } },
      ],
    });
    expect(host.status()).toMatchObject({
      activation: "inactive",
      configuration: { health: "invalid", lastFailure: expect.stringContaining("dup") },
    });
  });

  it("rejects cycles and missing required dependencies", async () => {
    const cycle = await fixture(validConfig(["a", "b"]));
    await expect(createHookHost({
      configPath: cycle.configPath,
      modules: [
        { id: "a", after: ["b"], tool_call: { guard: () => undefined } },
        { id: "b", after: ["a"], tool_call: { guard: () => undefined } },
      ],
    })).resolves.toMatchObject({ status: expect.any(Function) });
    const cycleHost = await createHookHost({
      configPath: cycle.configPath,
      modules: [
        { id: "a", after: ["b"], tool_call: { guard: () => undefined } },
        { id: "b", after: ["a"], tool_call: { guard: () => undefined } },
      ],
    });
    expect(cycleHost.status()).toMatchObject({ activation: "inactive", configuration: { health: "invalid" } });

    const missing = await fixture(validConfig(["a"]));
    const missingHost = await createHookHost({
      configPath: missing.configPath,
      modules: [{ id: "a", requires: ["required-module"], tool_call: { guard: () => undefined } }],
    });
    expect(missingHost.status().configuration.lastFailure).toContain("required-module");
  });
});

describe("configuration, activation, audit, and status", () => {
  it("parses JSONC, validates schema, and makes the Host inactive on invalid initial config", async () => {
    const good = await fixture(`{
      // trusted global configuration
      "schemaVersion": 1,
      "modules": [],
    }`);
    expect((await createHookHost({ configPath: good.configPath, modules: [] })).status().activation).toBe("active");

    const bad = await fixture(`{ "schemaVersion": 3, "modules": [] }`);
    const host = await createHookHost({ configPath: bad.configPath, modules: [] });
    // ADR-001: invalid configuration supplies no policy, regardless of tool provenance.
    const read = await host.dispatch(normalizeEvent("tool_call", { toolName: "read", toolCallId: "r", input: { path: "x" } }), ctx as never);
    const write = await host.dispatch(normalizeEvent("tool_call", { toolName: "write", toolCallId: "w", input: { path: "x", content: "secret" } }), ctx as never);
    expect(read).toMatchObject({ decision: "allow", mutated: false, input: { path: "x" } });
    expect(write).toMatchObject({ decision: "allow", mutated: false, input: { path: "x", content: "secret" } });
    expect(host.status()).toMatchObject({ activation: "inactive", configuration: { health: "invalid" } });
  });

  it("audits Inactive Host entry and module failures", async () => {
    const safe = await fixture(validConfig());
    await writeFile(safe.configPath, JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "a" }, { id: "b" }],
      audit: { path: safe.auditPath },
    }));
    await createHookHost({
      configPath: safe.configPath,
      modules: [
        { id: "a", after: ["b"] },
        { id: "b", after: ["a"] },
      ],
    });
    expect(await readFile(safe.auditPath, "utf8")).toContain('"decision":"inactive"');

    const failed = await fixture(validConfig());
    await writeFile(failed.configPath, JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "optional", required: false }],
      audit: { path: failed.auditPath },
    }));
    const host = await createHookHost({
      configPath: failed.configPath,
      modules: [{ id: "optional", tool_call: { guard: () => { throw new Error("boom"); } } }],
    });
    const result = await host.dispatch(normalizeEvent("tool_call", { toolName: "read", toolCallId: "f", input: { path: "x" } }), ctx as never);
    expect(result.decision).toBe("allow");
    expect(await readFile(failed.auditPath, "utf8")).toContain('"decision":"module-failure"');
    expect(host.status()).toMatchObject({ configuration: { health: "valid" }, runtime: { health: "degraded" } });
  });

  it("never blocks on observe failures: a required module's observe throw leaves the action allowed", async () => {
    const { configPath } = await fixture(validConfig(["watcher"]));
    const host = await createHookHost({
      configPath,
      modules: [{ id: "watcher", tool_call: { observe: () => { throw new Error("observer exploded"); } } }],
    });
    const result = await host.dispatch(normalizeEvent("tool_call", {
      toolName: "bash",
      toolCallId: "obs",
      input: { command: "echo hi" },
    }), ctx as never);
    expect(result.decision).toBe("allow");
    expect(host.status()).toMatchObject({
      runtime: { health: "degraded", lastFailure: expect.stringContaining("watcher observe failed") },
    });
  });

  it("minimizes and bounds audit records containing embedded secrets", async () => {
    const secrets = ["bearer-secret", "query-token", "url-password", "error-password", "input-token"];
    const module: HookModule = {
      id: "audit-policy",
      tool_call: {
        guard: () => { throw new Error("request failed password=error-password"); },
        transform: ({ input }) => ({ input: { ...input, password: "do-not-log" } }),
        internalFinal: () => ({
          decision: "deny",
          reason: "Bearer bearer-secret rejected https://user:url-password@example.test/run?token=query-token",
        }),
      },
    };
    const { configPath, auditPath } = await fixture(validConfig());
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "audit-policy", enabled: true, required: false }],
      audit: { path: auditPath },
    }));
    const host = await createHookHost({ configPath, modules: [module] });
    await host.dispatch(normalizeEvent("tool_call", {
      toolName: "bash",
      toolCallId: "x",
      input: {
        command: "curl -H 'Authorization: Bearer input-token' https://user:url-password@example.test/run?token=query-token",
        url: "https://example.test/?password=url-password",
        payload: "x".repeat(10_000),
      },
    }), ctx as never);
    const rawLines = (await readFile(auditPath, "utf8")).trim().split("\n");
    const lines = rawLines.map((line) => JSON.parse(line));
    expect(lines.some((line) => line.decision === "allow")).toBe(false);
    for (const secret of secrets) expect(JSON.stringify(lines)).not.toContain(secret);
    expect(JSON.stringify(lines)).not.toContain("do-not-log");
    expect(JSON.stringify(lines)).not.toContain("curl -H");
    expect(rawLines.every((line) => Buffer.byteLength(line) <= 2_048)).toBe(true);
    expect(lines.map((line) => line.decision)).toEqual(expect.arrayContaining(["module-failure", "mutate", "deny"]));
  });

  it("bounds in-memory audit retention while persisted JSONL stays complete, valid, and redacted", async () => {
    const { configPath, auditPath } = await fixture(validConfig());
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "denier" }],
      audit: { path: auditPath },
    }));
    const host = await createHookHost({
      configPath,
      modules: [{ id: "denier", tool_call: { guard: () => ({ decision: "deny" as const, reason: "blocked token=hunter2" }) } }],
    });

    for (let index = 0; index < 600; index += 1) {
      const result = await host.dispatch(normalizeEvent("tool_call", {
        toolName: "write",
        toolCallId: `call-${index}`,
        input: { path: `/tmp/file-${index}` },
      }), ctx as never);
      expect(result.decision).toBe("deny");
    }

    const retained = (host.status().audit as { retained?: number }).retained;
    expect(retained).toBeDefined();
    expect(retained!).toBeLessThanOrEqual(256);

    const rawLines = (await readFile(auditPath, "utf8")).trim().split("\n");
    expect(rawLines).toHaveLength(600);
    const lines = rawLines.map((line) => JSON.parse(line));
    expect(lines.every((line) => line.decision === "deny")).toBe(true);
    expect(JSON.stringify(lines)).not.toContain("hunter2");
  });

  it("contains Inactive Host startup audit failures and keeps status registered", async () => {
    const { configPath, auditPath } = await fixture(validConfig());
    await mkdir(auditPath);
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "a" }, { id: "b" }],
      audit: { path: auditPath },
    }));
    const pi = fakePi();
    await expect(createPiHooksExtension({
      configPath,
      modules: [
        { id: "a", after: ["b"] },
        { id: "b", after: ["a"] },
      ],
    })(pi.api as never)).resolves.toBeUndefined();

    expect(pi.handlers.has("tool_call")).toBe(true);
    await expect(pi.handlers.get("tool_call")?.(
      { type: "tool_call", toolName: "write", toolCallId: "safe", input: { path: "x" } },
      ctx,
    )).resolves.toBeUndefined();

    const notices: string[] = [];
    await pi.commands.get("hooks")?.handler("status", { ...ctx, ui: { notify: (text: string) => notices.push(text) } });
    expect(JSON.parse(notices[0])).toMatchObject({
      activation: "inactive",
      runtime: { health: "healthy" },
      audit: { health: "degraded", lastFailure: expect.any(String) },
    });
  });

  it("contains dispatch audit failures without overriding mutation or denial decisions", async () => {
    const { configPath, auditPath } = await fixture(validConfig());
    await mkdir(auditPath);
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "policy" }],
      audit: { path: auditPath },
    }));
    const host = await createHookHost({
      configPath,
      modules: [{
        id: "policy",
        tool_call: {
          transform: () => ({ input: { command: "echo safe" } }),
          internalFinal: () => ({ decision: "deny", reason: "blocked" }),
        },
      }],
    });

    await expect(host.dispatch(normalizeEvent("tool_call", {
      toolName: "bash",
      toolCallId: "deny",
      input: { command: "echo unsafe" },
    }), ctx as never)).resolves.toMatchObject({
      decision: "deny",
      reason: "blocked",
      input: { command: "echo safe" },
    });
    expect(host.status()).toMatchObject({ runtime: { health: "healthy" }, audit: { health: "degraded" } });
  });

  it("reports configuration, runtime module, and audit persistence health as three independent lanes", async () => {
    const { configPath, auditPath } = await fixture(validConfig());
    await mkdir(auditPath);
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "flaky", required: false }],
      audit: { path: auditPath },
    }));
    const host = await createHookHost({
      configPath,
      modules: [{ id: "flaky", tool_call: { guard: () => { throw new Error("flaky boom"); } } }],
    });
    const result = await host.dispatch(normalizeEvent("tool_call", {
      toolName: "bash",
      toolCallId: "lanes",
      input: { command: "echo hi" },
    }), ctx as never);
    expect(result.decision).toBe("allow");

    const status = host.status() as unknown as {
      configuration?: { health: string; lastFailure?: string };
      runtime?: { health: string; lastFailure?: string };
      audit: { health: string; lastFailure?: string };
    };
    expect(status.configuration).toMatchObject({ health: "valid" });
    expect(status.configuration?.lastFailure).toBeUndefined();
    expect(status.runtime).toMatchObject({ health: "degraded", lastFailure: expect.stringContaining("flaky") });
    expect(status.audit).toMatchObject({ health: "degraded", lastFailure: expect.any(String) });
  });

  it("reports config, modules, order, mode, health, and unavailable process-wide final interception", async () => {
    const { configPath } = await fixture(validConfig(["one"]));
    const pi = fakePi();
    const notices: string[] = [];
    await createPiHooksExtension({ configPath, modules: [{ id: "one", tool_call: { guard: () => undefined } }] })(pi.api as never);
    await pi.commands.get("hooks")?.handler("status", { ...ctx, ui: { notify: (text: string) => notices.push(text) } });
    const status = JSON.parse(notices[0]);
    expect(status).toMatchObject({
      configSource: configPath,
      configuration: { health: "valid" },
      modules: [{ id: "one", enabled: true }],
      activation: "active",
      finalInterceptor: { available: false },
    });
    expect(status.phaseOrder.guard).toEqual(["one"]);
    expect(status.finalInterceptor.boundary).toContain("later Pi extension");
    expect(pi.registrations).toEqual(["command:hooks"]);
  });
});

describe("native events and rejected compatibility aliases", () => {
  it.each([
    ["input", "input"],
    ["tool_call", "tool_call"],
    ["tool_result", "tool_result"],
    ["context", "context"],
    ["agent_end", "agent_end"],
    ["session_start", "session_start"],
    ["session_shutdown", "session_shutdown"],
    ["session_before_compact", "session_before_compact"],
    ["session_compact", "session_compact"],
  ])("normalizes native %s to %s", (source, expected) => {
    expect(normalizeEvent(source, { toolName: "bash", input: {} }).type).toBe(expected);
  });

  it.each([
    ["UserPromptSubmit", "input"],
    ["PreToolUse", "tool_call"],
    ["PostToolUse", "tool_result"],
    ["PostToolUseFailure", "tool_result"],
    ["Stop", "agent_end"],
    ["SessionStart", "session_start"],
    ["SessionEnd", "session_shutdown"],
    ["PreCompact", "session_before_compact"],
    ["PostCompact", "session_compact"],
  ])("rejects %s with a remedy naming %s", async (source, expected) => {
    expect(() => normalizeEvent(source, {})).toThrow(`Use native event ${expected}`);
    const { configPath } = await fixture(validConfig(["legacy"]));
    const host = await createHookHost({ configPath, modules: [{ id: "legacy", [source]: { observe() {} } }] });
    expect(host.status()).toMatchObject({ activation: "inactive", configuration: { lastFailure: expect.stringContaining(`Use native event ${expected}`) } });
  });
});

describe("isolation primitive contract", () => {
  it("privatizes shared memory reachable through non-enumerable structured fields like Error.cause", async () => {
    const { cloneDeep } = await import("../src/isolate.js");
    const live = new Uint8Array(new SharedArrayBuffer(4));
    const error = new Error("boom", { cause: live });
    const cloned = cloneDeep({ error }) as { error: Error };
    const clonedCause = cloned.error.cause as Uint8Array;
    expect(clonedCause).toBeInstanceOf(Uint8Array);
    clonedCause[0] = 7;
    expect(live[0]).toBe(0);
  });

  it("preserves repeated-reference identity when privatizing shared leaves in fallback clones", async () => {
    const { cloneDeep } = await import("../src/isolate.js");
    const live = new Uint8Array(new SharedArrayBuffer(2));
    class Wrapper {
      constructor(
        public first: Uint8Array,
        public second: Uint8Array,
      ) {}
    }
    const cloned = cloneDeep(new Wrapper(live, live)) as { first: Uint8Array; second: Uint8Array };
    expect(cloned.first).toBe(cloned.second);
    cloned.first[0] = 9;
    expect(cloned.second[0]).toBe(9);
    expect(live[0]).toBe(0);
  });

  it("rejects symbols on strict clone paths and drops them on the lenient event view", async () => {
    const { cloneDeep, safeFrozenView } = await import("../src/isolate.js");
    expect(() => cloneDeep({ marker: Symbol("live-handle") })).toThrow();
    const view = safeFrozenView({ marker: Symbol("live-handle"), kept: "value" } as Record<string, unknown>);
    expect(view.marker).toBeUndefined();
    expect(view.kept).toBe("value");
  });
});
