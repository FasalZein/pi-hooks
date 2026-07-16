import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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

function fakePi() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: Function }>();
  const registrations: string[] = [];
  return {
    api: {
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerCommand(name: string, command: { handler: Function }) {
        registrations.push(`command:${name}`);
        commands.set(name, command);
      },
      registerTool() { registrations.push("tool"); },
      getAllTools() { return []; },
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
  it("loads through Pi 0.80.7 public SDK APIs without tools or prompt additions", async () => {
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

  it("traverses the complete guard → transform → internal-final → context → observe path", async () => {
    const seen: string[] = [];
    const module: HookModule = {
      id: "tracer",
      guard: () => { seen.push("guard"); },
      transform: ({ input }) => { seen.push("transform"); return { input: { ...input, traced: true } }; },
      internalFinal: ({ input }) => { seen.push(`internal-final:${input.traced}`); },
      context: () => { seen.push("context"); return { context: "hidden tracer context" }; },
      observe: ({ decision, contextAdditions }) => { seen.push(`observe:${decision}:${contextAdditions.length}`); },
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
      transform: () => ({ input: { command: "echo safe", removed: undefined } }),
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
      { id: "c", after: ["b"], guard: () => { seen.push("c"); } },
      { id: "a", before: ["b"], guard: () => { seen.push("a"); } },
      { id: "b", guard: () => { seen.push("b"); } },
    ];
    const { configPath } = await fixture(validConfig(["c", "a", "b"]));
    const host = await createHookHost({ configPath, modules });
    await host.dispatch(normalizeEvent("tool_call", { toolName: "read", toolCallId: "1", input: { path: "x" } }), ctx as never);
    expect(seen).toEqual(["a", "b", "c"]);
    expect(host.status().phaseOrder.guard).toEqual(["a", "b", "c"]);
  });

  it("rejects cycles and missing required dependencies", async () => {
    const cycle = await fixture(validConfig(["a", "b"]));
    await expect(createHookHost({
      configPath: cycle.configPath,
      modules: [
        { id: "a", after: ["b"], guard: () => undefined },
        { id: "b", after: ["a"], guard: () => undefined },
      ],
    })).resolves.toMatchObject({ status: expect.any(Function) });
    const cycleHost = await createHookHost({
      configPath: cycle.configPath,
      modules: [
        { id: "a", after: ["b"], guard: () => undefined },
        { id: "b", after: ["a"], guard: () => undefined },
      ],
    });
    expect(cycleHost.status()).toMatchObject({ mode: "read-only-safe", configHealth: "invalid" });

    const missing = await fixture(validConfig(["a"]));
    const missingHost = await createHookHost({
      configPath: missing.configPath,
      modules: [{ id: "a", requires: ["required-module"], guard: () => undefined }],
    });
    expect(missingHost.status().lastFailure).toContain("required-module");
  });
});

describe("configuration, safe mode, audit, and status", () => {
  it("parses JSONC, validates schema, and enters Read-Only Safe Mode on invalid initial config", async () => {
    const good = await fixture(`{
      // trusted global configuration
      "schemaVersion": 1,
      "modules": [],
    }`);
    expect((await createHookHost({ configPath: good.configPath, modules: [] })).status().mode).toBe("normal");

    const bad = await fixture(`{ "schemaVersion": 2, "modules": [] }`);
    const host = await createHookHost({ configPath: bad.configPath, modules: [] });
    // Provenance-less detached dispatch fails closed for safe-mode reads (SLICE-0008):
    // only the real adapter path can attest trusted built-in provenance.
    const read = await host.dispatch(normalizeEvent("tool_call", { toolName: "read", toolCallId: "r", input: { path: "x" } }), ctx as never);
    const write = await host.dispatch(normalizeEvent("tool_call", { toolName: "write", toolCallId: "w", input: { path: "x", content: "secret" } }), ctx as never);
    expect(read).toMatchObject({ decision: "deny", reason: expect.stringContaining("Read-Only Safe Mode") });
    expect(write).toMatchObject({ decision: "deny", reason: expect.stringContaining("Read-Only Safe Mode") });
    expect(host.status()).toMatchObject({ mode: "read-only-safe", configHealth: "invalid" });
  });

  it("audits safe-mode entry and module failures", async () => {
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
    expect(await readFile(safe.auditPath, "utf8")).toContain('"decision":"safe-mode"');

    const failed = await fixture(validConfig());
    await writeFile(failed.configPath, JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "optional" }],
      audit: { path: failed.auditPath },
    }));
    const host = await createHookHost({
      configPath: failed.configPath,
      modules: [{ id: "optional", required: false, guard: () => { throw new Error("boom"); } }],
    });
    const result = await host.dispatch(normalizeEvent("tool_call", { toolName: "read", toolCallId: "f", input: { path: "x" } }), ctx as never);
    expect(result.decision).toBe("allow");
    expect(await readFile(failed.auditPath, "utf8")).toContain('"decision":"module-failure"');
    expect(host.status()).toMatchObject({ configHealth: "valid", health: "degraded" });
  });

  it("minimizes and bounds audit records containing embedded secrets", async () => {
    const secrets = ["bearer-secret", "query-token", "url-password", "error-password", "input-token"];
    const module: HookModule = {
      id: "audit-policy",
      required: false,
      guard: () => { throw new Error("request failed password=error-password"); },
      transform: ({ input }) => ({ input: { ...input, password: "do-not-log" } }),
      internalFinal: () => ({
        decision: "deny",
        reason: "Bearer bearer-secret rejected https://user:url-password@example.test/run?token=query-token",
      }),
    };
    const { configPath, auditPath } = await fixture(validConfig());
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "audit-policy", enabled: true }],
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

  it("contains safe-mode startup audit failures and keeps enforcement registered", async () => {
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
    )).resolves.toMatchObject({ block: true, reason: expect.stringContaining("Read-Only Safe Mode") });

    const notices: string[] = [];
    await pi.commands.get("hooks")?.handler("status", { ...ctx, ui: { notify: (text: string) => notices.push(text) } });
    expect(JSON.parse(notices[0])).toMatchObject({
      mode: "read-only-safe",
      health: "degraded",
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
        transform: () => ({ input: { command: "echo safe" } }),
        internalFinal: () => ({ decision: "deny", reason: "blocked" }),
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
    expect(host.status()).toMatchObject({ health: "degraded", audit: { health: "degraded" } });
  });

  it("reports config, modules, order, mode, health, and unavailable process-wide final interception", async () => {
    const { configPath } = await fixture(validConfig(["one"]));
    const pi = fakePi();
    const notices: string[] = [];
    await createPiHooksExtension({ configPath, modules: [{ id: "one", guard: () => undefined }] })(pi.api as never);
    await pi.commands.get("hooks")?.handler("status", { ...ctx, ui: { notify: (text: string) => notices.push(text) } });
    const status = JSON.parse(notices[0]);
    expect(status).toMatchObject({
      configSource: configPath,
      configHealth: "valid",
      modules: [{ id: "one", enabled: true }],
      mode: "normal",
      finalInterceptor: { available: false },
    });
    expect(status.phaseOrder.guard).toEqual(["one"]);
    expect(status.finalInterceptor.boundary).toContain("later Pi extension");
    expect(pi.registrations).toEqual(["command:hooks"]);
  });
});

describe("normalized events and compatibility aliases", () => {
  it.each([
    ["input", "input"],
    ["tool_call", "tool_call"],
    ["tool_result", "tool_result"],
    ["agent_end", "agent_end"],
    ["session_start", "session_start"],
    ["session_shutdown", "session_shutdown"],
    ["session_before_compact", "session_before_compact"],
    ["session_compact", "session_compact"],
    ["UserPromptSubmit", "input"],
    ["PreToolUse", "tool_call"],
    ["PostToolUse", "tool_result"],
    ["PostToolUseFailure", "tool_result"],
    ["Stop", "agent_end"],
    ["SessionStart", "session_start"],
    ["SessionEnd", "session_shutdown"],
    ["PreCompact", "session_before_compact"],
    ["PostCompact", "session_compact"],
  ])("normalizes %s to %s", (source, expected) => {
    expect(normalizeEvent(source, { toolName: "bash", toolInput: {}, isError: source === "PostToolUseFailure" }).type).toBe(expected);
  });
});
