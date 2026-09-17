import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const recipe = (id: string, marker: string) => ({
  id,
  event: "tool_call",
  tool: "bash",
  commands: [{ command: process.execPath, args: ["-e", `require('fs').appendFileSync(${JSON.stringify(marker)},'ran\\n')`] }],
  timeoutMs: 3000,
});

async function withInstalledPreset(config: string, run: (session: Awaited<ReturnType<typeof createAgentSession>>["session"], dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-hooks-recipe-preset-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await writeFile(join(dir, "pi-hooks.jsonc"), config.replaceAll("__DIR__", dir));
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true, additionalExtensionPaths: [root], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
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

async function hooksStatus(session: Awaited<ReturnType<typeof createAgentSession>>["session"]) {
  const notices: string[] = [];
  await session.extensionRunner!.getCommand("hooks")!.handler("status", { ui: { notify: (text: string) => notices.push(text) } } as never);
  return JSON.parse(notices[0]);
}

describe("path-installed Preset", () => {
  it("loads both policy and LSP from an explicit helper allowlist in an isolated profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-helper-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true, additionalExtensionPaths: [root], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({ cwd: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
      try {
        await session.bindExtensions({});
        expect(session.getAllTools().filter((tool) => tool.name === "lsp")).toHaveLength(1);
        expect(session.extensionRunner!.getCommand("hooks")).toBeDefined();
        expect(session.extensionRunner!.getCommand("lsp")).toBeDefined();
        expect(await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "helper-danger", input: { command: "rm file" } })).toMatchObject({ block: true, reason: expect.stringContaining("danger-01") });
      } finally {
        await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("protects equivalent command forms without changing the Host-final input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-command-parity-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      await writeFile(join(dir, "pi-hooks.jsonc"), JSON.stringify({ schemaVersion: 2, rendering: false }));
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true, additionalExtensionPaths: [root], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({ cwd: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
      try {
        const protectedCommands = ["  rm disposable", "\\sudo true", "/opt/homebrew/bin/rm -rf disposable", "./rm --recursive --force disposable"];
        for (const [index, command] of protectedCommands.entries()) {
          expect(await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: `no-ui-${index}`, input: { command } })).toMatchObject({ block: true, reason: expect.stringContaining("Remedy:") });
        }
        for (const [index, command] of ["echo /opt/homebrew/bin/rm -rf disposable", "printf './rm -rf disposable'", "npm run verify"].entries()) {
          expect(await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: `ordinary-${index}`, input: { command } })).toBeUndefined();
        }

        const prompts: string[] = [];
        await session.bindExtensions({ uiContext: { confirm: async (_title: string, message: string) => { prompts.push(message); return true; }, notify() {}, setStatus() {} } as never });
        for (const [index, command] of protectedCommands.entries()) {
          const event = { type: "tool_call", toolName: "bash", toolCallId: `interactive-${index}`, input: { command } } as const;
          expect(await session.extensionRunner!.emitToolCall(event)).toBeUndefined();
          expect(event.input.command).toBe(command);
          expect(prompts.at(-1)).toContain(`Command: ${command}\n`);
        }
      } finally {
        await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["duplicate", [recipe("duplicate", "duplicate.txt"), recipe("duplicate", "duplicate.txt")]],
    ["broken", [{ ...recipe("broken", "broken.txt"), timeoutMs: 0 }]],
  ])("isolates %s top-level Recipe configuration with a named diagnostic", async (id, recipes) => {
    await withInstalledPreset(JSON.stringify({
      schemaVersion: 2,
      rendering: false,
      audit: { path: "__DIR__/audit.jsonl" },
      recipes,
      rules: [{ id: "healthy-policy", match: { tool: "bash" }, decision: "deny", scope: "test", remedy: "use another tool" }],
    }), async (session, dir) => {
      const status = await hooksStatus(session);
      const expectedFailure = id === "duplicate"
        ? "activation failed: Recipe duplicate: duplicate id"
        : "config invalid: entry broken /recipes/0/timeoutMs: must be >= 1";
      expect(status).toMatchObject({
        activation: "active",
        configuration: { health: "valid" },
        runtime: { health: "degraded", lastFailure: `provider action-engine ${expectedFailure}` },
        providers: [
          expect.objectContaining({ id: "policy-engine", enabled: true, health: "healthy" }),
          expect.objectContaining({ id: "action-engine", enabled: false, health: "degraded", lastFailure: expectedFailure }),
        ],
      });
      expect(await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: id, input: { command: "echo protected" } })).toMatchObject({ block: true, reason: expect.stringContaining("healthy-policy") });
      const audit = await readFile(join(dir, "audit.jsonl"), "utf8");
      expect(audit).toContain('"provider":"action-engine"');
      expect(audit).toContain('"decision":"module-failure"');
      expect(audit).not.toContain('"decision":"inactive"');
    });
  });

  it.each([
    ["root-level config", "invalid", "/: must be object"],
    ["multiple Recipe fields", { recipes: [{ ...recipe("multi", "multi.txt"), event: "", timeoutMs: 0 }] }, "entry multi /recipes/0/event: must not have fewer than 1 characters; entry multi /recipes/0/timeoutMs: must be >= 1"],
    ["non-string Recipe id", { recipes: [{ ...recipe("ignored", "number-id.txt"), id: 7 }] }, "/recipes/0/id: must be string"],
  ])("preserves %s Action Engine validation diagnostics", async (_case, actionConfig, expectedFailure) => {
    await withInstalledPreset(JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "action-engine", required: false, config: actionConfig }],
      rules: [{ id: "healthy-policy", match: { tool: "bash" }, decision: "deny", scope: "test", remedy: "use another tool" }],
    }), async (session) => {
      expect(await hooksStatus(session)).toMatchObject({
        activation: "active",
        runtime: { health: "degraded", lastFailure: `provider action-engine config invalid: ${expectedFailure}` },
        providers: [
          expect.objectContaining({ id: "policy-engine", enabled: true, health: "healthy" }),
          expect.objectContaining({ id: "action-engine", enabled: false, health: "degraded", lastFailure: `config invalid: ${expectedFailure}` }),
        ],
      });
      expect(await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "invalid-explicit", input: { command: "echo protected" } })).toMatchObject({ block: true, reason: expect.stringContaining("healthy-policy") });
    });
  });

  it("adds and disables top-level named Recipes through the installed Preset", async () => {
    await withInstalledPreset(JSON.stringify({
      schemaVersion: 2,
      recipes: [recipe("active", "active.txt"), { ...recipe("disabled", "disabled.txt"), enabled: false }],
    }), async (session, dir) => {
      await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "named", input: { command: "echo ok" } });
      expect(await readFile(join(dir, "active.txt"), "utf8")).toBe("ran\n");
      await expect(readFile(join(dir, "disabled.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect((await hooksStatus(session)).modules.map((module: { id: string }) => module.id)).toContain("recipe:active");
      expect((await hooksStatus(session)).modules.map((module: { id: string }) => module.id)).not.toContain("recipe:disabled");
    });
  });

  it("treats explicit Action Engine config as a whole-Provider replacement", async () => {
    await withInstalledPreset(JSON.stringify({
      schemaVersion: 2,
      recipes: [recipe("replace-me", "top-level.txt")],
      providers: [{ id: "action-engine", required: false, config: { recipes: [recipe("replace-me", "explicit.txt")] } }],
    }), async (session, dir) => {
      await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "mixed", input: { command: "echo ok" } });
      await expect(readFile(join(dir, "top-level.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(dir, "explicit.txt"), "utf8")).toBe("ran\n");
      expect((await hooksStatus(session)).modules.map((module: { id: string }) => module.id)).toContain("recipe:replace-me");
    });
  });

  it("keeps malformed whole configuration inactive without Preset fallback policy", async () => {
    await withInstalledPreset('{ "schemaVersion": 2, "recipes": [', async (session) => {
      expect(await hooksStatus(session)).toMatchObject({
        activation: "inactive",
        configuration: { health: "invalid", lastFailure: expect.stringContaining("Invalid JSONC") },
        runtime: { health: "healthy" },
        providers: [],
      });
      expect(await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "inactive", input: { command: "rm file" } })).toBeUndefined();
    });
  });

  it("keeps duplicate explicit Provider entries as an invalid whole configuration", async () => {
    await withInstalledPreset(JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "action-engine" }, { id: "action-engine" }],
    }), async (session) => {
      expect(await hooksStatus(session)).toMatchObject({
        activation: "inactive",
        configuration: { health: "invalid", lastFailure: "Duplicate Provider configuration: action-engine" },
        runtime: { health: "healthy" },
        providers: [],
      });
      expect(await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "duplicate-provider", input: { command: "rm file" } })).toBeUndefined();
    });
  });

  it("loads the manifest Preset with default policy and keeps the library default bare", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(manifest.exports["."]).toBe("./src/index.ts");
    expect(manifest.pi.extensions).toContain("./src/preset.ts");
    expect(manifest.pi.extensions).not.toContain("./src/index.ts");
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-preset-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      await writeFile(join(dir, "settings.json"), JSON.stringify({ packages: [root] }));
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({ cwd: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
      try {
        const notices: string[] = [];
        await session.extensionRunner!.getCommand("hooks")!.handler("status", { ui: { notify: (text: string) => notices.push(text) } } as never);
        expect(JSON.parse(notices[0])).toMatchObject({ activation: "active", preset: "pi-hooks", providers: [expect.objectContaining({ id: "policy-engine", enabled: true }), expect.objectContaining({ id: "action-engine", enabled: true })] });
        expect(await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "default", input: { command: "echo allowed" } } as never)).toBeUndefined();
      } finally { session.dispose(); }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
