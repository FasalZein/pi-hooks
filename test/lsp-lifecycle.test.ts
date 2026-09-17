import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const serverScript = join(root, "test/fixtures/lifecycle-lsp-server.mjs");
const temporaryDirectories: string[] = [];

function config(label: string, logPath: string, enabled = true) {
  return JSON.stringify({
    schemaVersion: 2,
    lsp: {
      servers: {
        lifecycle: {
          enabled,
          command: process.execPath,
          args: [serverScript, label, logPath],
          languages: [{ extensions: [".life"], languageId: "lifecycle" }],
        },
      },
    },
  }, null, 2);
}

async function loadProfile(dir: string) {
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    noExtensions: true,
    additionalExtensionPaths: [root],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  return loader;
}

async function createProfile(label = "A", enabled = true) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-hooks-lifecycle-"));
  temporaryDirectories.push(dir);
  const logPath = join(dir, "processes.log");
  const file = join(dir, "example.life");
  await writeFile(file, "content\n");
  await writeFile(join(dir, "pi-hooks.jsonc"), config(label, logPath, enabled));
  const loader = await loadProfile(dir);
  return { dir, file, loader, logPath };
}

async function bind(session: AgentSession) {
  await session.bindExtensions({ mode: "rpc", uiContext: {
    notify() {},
    confirm: async () => true,
    select: async () => undefined,
    input: async () => undefined,
    onTerminalInput: () => () => undefined,
    setStatus() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    custom: async () => undefined,
  } as never });
}

async function callTool(session: AgentSession, input: Record<string, unknown>) {
  const tool = session.getToolDefinition("lsp")!;
  const prepared = tool.prepareArguments?.(input) ?? input;
  const toolCallId = `lifecycle-${Math.random()}`;
  const event = { type: "tool_call", toolName: "lsp", toolCallId, input: prepared };
  expect(await session.extensionRunner!.emitToolCall(event as never)).toBeUndefined();
  const result = await tool.execute(toolCallId, prepared, undefined, undefined, session.extensionRunner!.createContext());
  const patch = await session.extensionRunner!.emitToolResult({
    type: "tool_result",
    toolName: "lsp",
    toolCallId,
    input: prepared,
    ...result,
    isError: false,
  } as never);
  return { ...result, ...patch, toolCallId };
}

async function runCommand(session: AgentSession, args: string) {
  await session.extensionRunner!.getCommand("lsp")!.handler(args, session.extensionRunner!.createContext() as never);
}

async function statusText(session: AgentSession) {
  return JSON.stringify((await callTool(session, { operation: "status" })).content);
}

async function statusState(session: AgentSession) {
  const result = await callTool(session, { operation: "status" });
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return (JSON.parse(text) as { servers: Array<{ serverId: string; state: string }> }).servers
    .find(({ serverId }) => serverId === "lifecycle")!.state;
}

async function processEvents(logPath: string) {
  try {
    return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function pidFor(events: string[], event: string, label: string) {
  const line = [...events].reverse().find((candidate) => candidate.startsWith(`${event} ${label} `));
  expect(line).toBeDefined();
  return Number(line!.split(" ")[2]);
}

function expectProcessStopped(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

async function shutdown(session: AgentSession | undefined) {
  if (!session) return;
  await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Pi LSP lifecycle proof", () => {
  it("reloads a changed Server Definition and releases obsolete processes", async () => {
    const profile = await createProfile("A");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = profile.dir;
    let session: AgentSession | undefined;
    let fresh: AgentSession | undefined;
    try {
      ({ session } = await createAgentSession({ cwd: profile.dir, resourceLoader: profile.loader, sessionManager: SessionManager.inMemory(profile.dir) }));
      await bind(session);
      expect(JSON.stringify((await callTool(session, { operation: "diagnostics", file_path: profile.file })).content)).toContain("definition-A");
      const firstPid = pidFor(await processEvents(profile.logPath), "START", "A");

      await writeFile(join(profile.dir, "pi-hooks.jsonc"), config("B", profile.logPath));
      await session.reload();
      expectProcessStopped(firstPid);
      expect(await processEvents(profile.logPath)).toContain(`STOP A ${firstPid}`);
      expect(JSON.stringify((await callTool(session, { operation: "diagnostics", file_path: profile.file })).content)).toContain("definition-B");
      const secondPid = pidFor(await processEvents(profile.logPath), "START", "B");
      expect(secondPid).not.toBe(firstPid);

      await runCommand(session, "disable lifecycle --global");
      expectProcessStopped(secondPid);
      await session.reload();
      expect(await statusText(session)).toContain("disabled");
      await runCommand(session, "enable lifecycle --global");
      await runCommand(session, "disable lifecycle");
      await session.reload();
      expect(await statusText(session)).toContain("disabled");

      ({ session: fresh } = await createAgentSession({ cwd: profile.dir, resourceLoader: await loadProfile(profile.dir), sessionManager: SessionManager.inMemory(profile.dir) }));
      await bind(fresh);
      expect(JSON.stringify((await callTool(fresh, { operation: "diagnostics", file_path: profile.file })).content)).toContain("definition-B");
    } finally {
      await shutdown(fresh);
      await shutdown(session);
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("restores resume previews and keeps tree and fork state on the selected ancestor branch", async () => {
    const profile = await createProfile("resume", false);
    const sessionDir = join(profile.dir, "sessions");
    await mkdir(sessionDir);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = profile.dir;
    let active: AgentSession | undefined;
    let runtime: AgentSessionRuntime | undefined;
    try {
      const manager = SessionManager.create(profile.dir, sessionDir);
      const ancestorId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "ancestor" }], timestamp: Date.now() } as never);
      ({ session: active } = await createAgentSession({ cwd: profile.dir, resourceLoader: profile.loader, sessionManager: manager }));
      await bind(active);
      await runCommand(active, "enable lifecycle");
      const preview = await callTool(active, {
        operation: "format_document",
        file_path: profile.file,
        server_id: "lifecycle",
        tab_size: 2,
        insert_spaces: true,
      });
      const previewId = (preview.details as { preview_id: string }).preview_id;
      const previewEntryId = manager.appendMessage({
        role: "toolResult",
        toolCallId: preview.toolCallId,
        toolName: "lsp",
        content: preview.content,
        details: preview.details,
        isError: false,
        timestamp: Date.now(),
      } as never);
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "saved" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      } as never);
      const sessionFile = manager.getSessionFile()!;
      await shutdown(active);
      active = undefined;
      const previewPid = pidFor(await processEvents(profile.logPath), "START", "resume");
      expectProcessStopped(previewPid);

      const resumedManager = SessionManager.open(sessionFile, sessionDir);
      expect(resumedManager.getBranch()).toContainEqual(expect.objectContaining({
        type: "custom",
        customType: "pi-lsp-enablement",
        data: { serverId: "lifecycle", enabled: true },
      }));
      ({ session: active } = await createAgentSession({
        cwd: profile.dir,
        resourceLoader: await loadProfile(profile.dir),
        sessionManager: resumedManager,
        sessionStartEvent: { type: "session_start", reason: "resume" },
      }));
      await bind(active);
      expect(await statusState(active)).not.toBe("disabled");
      await callTool(active, { operation: "apply", preview_id: previewId });
      expect(await readFile(profile.file, "utf8")).toContain("// formatted-resume");

      await runCommand(active, "disable lifecycle");
      const disabledEntryId = resumedManager.getLeafId()!;
      expect(await statusText(active)).toContain("disabled");
      await active.navigateTree(previewEntryId);
      expect(await statusState(active)).not.toBe("disabled");
      await callTool(active, { operation: "diagnostics", file_path: profile.file });
      const treePid = pidFor(await processEvents(profile.logPath), "START", "resume");
      await active.navigateTree(disabledEntryId);
      expect(await statusText(active)).toContain("disabled");
      expectProcessStopped(treePid);
      await active.navigateTree(previewEntryId);
      expect(await statusState(active)).not.toBe("disabled");

      const services = { cwd: profile.dir, agentDir: profile.dir } as never;
      const factory: CreateAgentSessionRuntimeFactory = async (options) => {
        const result = await createAgentSession({
          cwd: options.cwd,
          agentDir: options.agentDir,
          resourceLoader: await loadProfile(options.cwd),
          sessionManager: options.sessionManager,
          sessionStartEvent: options.sessionStartEvent,
        });
        await bind(result.session);
        return { ...result, services, diagnostics: [] };
      };
      runtime = new AgentSessionRuntime(active, services, factory);
      const beforeFork = await callTool(active, { operation: "diagnostics", file_path: profile.file });
      expect(JSON.stringify(beforeFork.content)).toContain("definition-resume");
      const beforeForkPid = pidFor(await processEvents(profile.logPath), "START", "resume");
      const fork = await runtime.fork(previewEntryId, { position: "at" });
      active = undefined;
      expect(fork.cancelled).toBe(false);
      expectProcessStopped(beforeForkPid);
      expect(await statusState(runtime.session)).not.toBe("disabled");
      expect(runtime.session.sessionManager.getBranch().some((entry) => entry.id === disabledEntryId)).toBe(false);
      expect(runtime.session.sessionManager.getBranch().some((entry) => entry.id === ancestorId)).toBe(true);

      const freshManager = SessionManager.create(profile.dir, sessionDir);
      const fresh = await createAgentSession({ cwd: profile.dir, resourceLoader: await loadProfile(profile.dir), sessionManager: freshManager });
      try {
        await bind(fresh.session);
        expect(await statusText(fresh.session)).toContain("disabled");
      } finally {
        await shutdown(fresh.session);
      }
    } finally {
      if (runtime) await runtime.dispose();
      else await shutdown(active);
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("loads only the dedicated package and explicit LSP tool in a fresh process", async () => {
    const profile = await createProfile("fresh");
    const projectExtensions = join(profile.dir, ".pi/extensions");
    await mkdir(projectExtensions, { recursive: true });
    const marker = join(profile.dir, "project-extension-loaded");
    await writeFile(join(projectExtensions, "project.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); export default function (pi) { pi.registerCommand("project-command", { handler() {} }); }\n`);
    const runner = join(profile.dir, "fresh-process.mjs");
    const sdkUrl = pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href;
    await writeFile(runner, `
      import { existsSync } from "node:fs";
      const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(${JSON.stringify(sdkUrl)});
      const [cwd, packageRoot, marker, file] = process.argv.slice(2);
      process.env.PI_CODING_AGENT_DIR = cwd;
      const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true, additionalExtensionPaths: [packageRoot], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      let session;
      try {
        await loader.reload();
        ({ session } = await createAgentSession({ cwd, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: ["lsp"] }));
        await session.bindExtensions({});
        const tool = session.getToolDefinition("lsp");
        const input = tool.prepareArguments?.({ operation: "diagnostics", file_path: file }) ?? { operation: "diagnostics", file_path: file };
        const diagnostic = await tool.execute("fresh-process", input, undefined, undefined, session.extensionRunner.createContext());
        console.log(JSON.stringify({
          errors: loader.getExtensions().errors,
          activeTools: session.getActiveToolNames(),
          lspTools: session.getAllTools().filter((candidate) => candidate.name === "lsp").length,
          commands: ["hooks", "lsp", "project-command"].filter((name) => session.extensionRunner.getCommand(name)),
          projectImported: existsSync(marker),
          diagnostic: JSON.stringify(diagnostic.content),
        }));
      } finally {
        if (session) {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session.dispose();
        }
      }
    `);
    const { stdout } = await exec(process.execPath, [runner, profile.dir, root, marker, profile.file], { cwd: root, timeout: 20_000 });
    const result = JSON.parse(stdout.trim());
    expect(result).toEqual({
      errors: [],
      activeTools: ["lsp"],
      lspTools: 1,
      commands: ["hooks", "lsp"],
      projectImported: false,
      diagnostic: expect.stringContaining("definition-fresh"),
    });
  });
});
