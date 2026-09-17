import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { actionEngineProvider, createHookHost, normalizeEvent, type Recipe } from "../src/index.js";
import { EVENT_TYPES } from "../src/types.js";
import { runProcess } from "../src/process-runner.js";

const entry = fileURLToPath(new URL("../src/preset.ts", import.meta.url));
const hooksIndexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const command = (script: string) => ({ command: process.execPath, args: ["-e", script] });
const recipe = (id: string, event: string, script: string, extra: Partial<Recipe> = {}): Recipe => ({ id, event, commands: [command(script)], timeoutMs: 3000, ...extra });
const execFileAsync = promisify(execFile);

async function withRecipes(
  recipes: unknown[],
  run: (session: AgentSession, dir: string) => Promise<void>,
  policyRules: unknown[] = [],
  extensionSource?: string,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-hooks-recipes-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const providers = [
      { id: "action-engine", required: false, config: { recipes } },
      ...(extensionSource === undefined ? [] : [{ id: "host-transform" }]),
      { id: "policy-engine", config: { rules: policyRules } },
    ];
    await writeFile(join(dir, "pi-hooks.jsonc"), JSON.stringify({ schemaVersion: 2, audit: { path: join(dir, "audit.jsonl"), includeAllows: true }, providers }));
    const extensionPath = extensionSource === undefined ? entry : join(dir, "recipe-extension.ts");
    if (extensionSource !== undefined) await writeFile(extensionPath, extensionSource);
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, additionalExtensionPaths: [extensionPath], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
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
  await session.extensionRunner!.getCommand("hooks")!.handler("status", { ui: { notify: (text: string) => notices.push(text) } } as never);
  return JSON.parse(notices[0]);
}

const call = { type: "tool_call", toolName: "bash", toolCallId: "recipe-call", input: { command: "echo ok" } } as const;

describe("Action Engine via the real Pi loader", () => {
  it("runs each native event with a session-bound Event envelope and literal argv in order", async () => {
    const literal = "$(touch not-created); * && echo nope";
    const recipes = EVENT_TYPES.map((event) => ({ ...recipe(event, event, ""), commands: [
      { command: process.execPath, args: ["-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('fs').appendFileSync('events.jsonl',JSON.stringify({envelope:JSON.parse(s),arg:process.argv[1]})+'\\n'))", literal] },
      command("require('fs').appendFileSync('order.txt','second\\n')"),
    ] }));
    await withRecipes(recipes, async (session, dir) => {
      const runner = session.extensionRunner!;
      await session.bindExtensions({});
      await runner.emitInput("hello", undefined, "interactive");
      await runner.emitToolCall(call);
      await runner.emitToolResult({ type: "tool_result", toolName: "bash", toolCallId: "result", input: {}, content: [], details: undefined, isError: false });
      await runner.emitContext([]);
      await runner.emit({ type: "agent_end", messages: [] });
      await runner.emit({ type: "session_before_compact" } as never);
      await runner.emit({ type: "session_compact" } as never);
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      const rows = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(rows.map((row) => row.envelope.event).sort()).toEqual([...EVENT_TYPES].sort());
      for (const row of rows) {
        expect(row.envelope.sessionId).toBe(session.sessionManager.getSessionId());
        expect(row.envelope.payload.type).toBe(row.envelope.event);
        expect(row.arg).toBe(literal);
      }
      expect((await readFile(join(dir, "order.txt"), "utf8")).trim().split("\n")).toHaveLength(9);
      await expect(readFile(join(dir, "not-created"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await status(session)).modules.map((module: { id: string }) => module.id)).toContain("recipe:input");
    });
  });

  it.each(["ignore", "block"] as const)("handles a timeout with onFailure %s", async (onFailure) => {
    await withRecipes([recipe("slow", "tool_call", "setInterval(()=>{},1000)", { timeoutMs: 20, onFailure })], async (session, dir) => {
      const result = await session.extensionRunner!.emitToolCall(call);
      if (onFailure === "block") expect(result).toMatchObject({ block: true, reason: expect.stringContaining("Recipe slow") });
      else expect(result).toBeUndefined();
      expect((await status(session)).runtime).toMatchObject({ health: "degraded", lastFailure: expect.stringContaining("timed out") });
      expect(await readFile(join(dir, "audit.jsonl"), "utf8")).toContain('"provider":"action-engine"');
    });
  });

  it("bounds an idle lifecycle Recipe by its explicit timeout", async () => {
    await withRecipes([recipe("idle-lifecycle", "session_start", "setInterval(()=>{},1000)", { timeoutMs: 20 })], async (session) => {
      expect(session.isIdle).toBe(true);
      await session.extensionRunner!.emit({ type: "session_start", reason: "startup" });
      expect((await status(session)).runtime).toMatchObject({
        health: "degraded",
        lastFailure: expect.stringContaining("Recipe idle-lifecycle: command timed out after 20ms"),
      });
    });
  });

  it.each([
    recipe("wrong-failure", "input", "", { onFailure: "block" }),
    recipe("legacy", "PreToolUse", ""),
    { ...recipe("bad-timeout", "input", ""), timeoutMs: 0 },
  ])("isolates invalid Recipe $id without disabling policy", async (invalid) => {
    await withRecipes([invalid], async (session) => {
      expect(await status(session)).toMatchObject({ activation: "active", providers: [expect.objectContaining({ id: "policy-engine", enabled: true }), expect.objectContaining({ id: "action-engine", enabled: false, health: "degraded" })] });
      expect(await session.extensionRunner!.emitToolCall(call)).toBeUndefined();
    });
  });

  it.each([
    ["context before block", [{ type: "add-context", text: "must not leak" }, { type: "block", reason: "ask the owner" }]],
    ["block before context", [{ type: "block", reason: "ask the owner" }, { type: "add-context", text: "must not leak" }]],
  ])("discards same-Recipe context when %s", async (_label, effects) => {
    await withRecipes([
      recipe("blocker", "tool_call", `console.log(${JSON.stringify(JSON.stringify(effects))})`, { effects: ["add-context", "block"] }),
    ], async (session, dir) => {
      const runner = session.extensionRunner!;
      expect(await runner.emitToolCall(call)).toMatchObject({ block: true, reason: "Recipe blocker: ask the owner" });
      expect(await runner.emitContext([])).toEqual([]);
      const audit = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(audit).toContainEqual(expect.objectContaining({ moduleId: "recipe:blocker", provider: "action-engine", decision: "deny" }));
    });
  });

  it("discards earlier Recipe context when a later Recipe denies the call", async () => {
    await withRecipes([
      recipe("context-first", "tool_call", `console.log(JSON.stringify({type:'add-context',text:'must not leak'}))`, { effects: ["add-context"] }),
      recipe("block-later", "tool_call", `console.log(JSON.stringify({type:'block',reason:'later denial'}))`, { effects: ["block"] }),
    ], async (session) => {
      const runner = session.extensionRunner!;
      expect(await runner.emitToolCall(call)).toMatchObject({ block: true, reason: "Recipe block-later: later denial" });
      expect(await runner.emitContext([])).toEqual([]);
    });
  });

  it("discards Recipe context when final policy denies transformed input", async () => {
    await withRecipes([
      recipe("context-first", "tool_call", `console.log(JSON.stringify({type:'add-context',text:'must not leak'}))`, { effects: ["add-context"] }),
    ], async (session, dir) => {
      const runner = session.extensionRunner!;
      expect(await runner.emitToolCall(call)).toMatchObject({ block: true, reason: expect.stringContaining("deny-transformed") });
      expect(JSON.parse(await readFile(join(dir, "observed-context.json"), "utf8"))).toEqual([]);
      expect(await runner.emitContext([])).toEqual([]);
    }, [{ id: "deny-transformed", match: { input: { command: { equals: "denied after transform" } } }, decision: "hard-deny", scope: "test", remedy: "use safe input" }], transformedPolicyExtension());
  });

  it("keeps pre-existing and overlapping allowed-call context, then drains it once", async () => {
    const readInput = "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const input=JSON.parse(s).input;";
    await withRecipes([
      recipe("pre-existing", "input", `console.log(JSON.stringify({type:'add-context',text:'pre-existing'}))`, { effects: ["add-context"] }),
      recipe("per-call-context", "tool_call", `${readInput}setTimeout(()=>console.log(JSON.stringify({type:'add-context',text:'context '+input.command})),input.command==='allowed'?30:5)})`, { effects: ["add-context"] }),
      recipe("conditional-block", "tool_call", `${readInput}if(input.command==='denied')console.log(JSON.stringify({type:'block',reason:'denied call'}))})`, { effects: ["block"] }),
    ], async (session) => {
      const runner = session.extensionRunner!;
      await runner.emitInput("hello", undefined, "interactive");
      const [denied, allowed] = await Promise.all([
        runner.emitToolCall({ ...call, toolCallId: "denied", input: { command: "denied" } }),
        runner.emitToolCall({ ...call, toolCallId: "allowed", input: { command: "allowed" } }),
      ]);
      expect(denied).toMatchObject({ block: true, reason: "Recipe conditional-block: denied call" });
      expect(allowed).toBeUndefined();
      const firstContext = JSON.stringify(await runner.emitContext([]));
      expect(firstContext).toContain("pre-existing");
      expect(firstContext).toContain("context allowed");
      expect(firstContext).not.toContain("context denied");
      expect(await runner.emitContext([])).toEqual([]);
    });
  });

  it("applies declared block, context, and result effects through Pi", async () => {
    await withRecipes([
      recipe("blocker", "tool_call", `console.log(JSON.stringify({type:'block',reason:'ask the owner'}))`, { tool: "bash", effects: ["block"] }),
      recipe("context", "input", `console.log(JSON.stringify({type:'add-context',text:'Recipe context'}))`, { effects: ["add-context"] }),
      recipe("patch", "tool_result", `console.log(JSON.stringify({type:'patch-result',content:[{type:'text',text:'patched by Recipe'}]}))`, { effects: ["patch-result"] }),
    ], async (session, dir) => {
      const runner = session.extensionRunner!;
      expect(await runner.emitToolCall(call)).toMatchObject({ block: true, reason: "Recipe blocker: ask the owner" });
      await runner.emitInput("hello", undefined, "interactive");
      expect(JSON.stringify(await runner.emitContext([]))).toContain("Recipe context");
      expect(await runner.emitContext([])).toEqual([]);
      const patch = await runner.emitToolResult({ type: "tool_result", toolName: "bash", toolCallId: "result", input: {}, content: [{ type: "text", text: "original" }], details: undefined, isError: false });
      expect(patch?.content).toEqual([{ type: "text", text: "patched by Recipe" }]);
      expect(await readFile(join(dir, "audit.jsonl"), "utf8")).toContain('"moduleId":"recipe:blocker"');
    });
  });

  it.each([
    ['{"type":"unknown"}', [], "unsupported"],
    ['{"type":"block","reason":"no"}', [], "refused block"],
    ['{"type":"patch-result","content":[]}', ["patch-result"], "refused patch-result"],
    ["not json", [], "malformed stdout"],
  ])("refuses invalid stdout %s without blocking", async (output, effects, reason) => {
    await withRecipes([recipe("refusal", "tool_call", `console.log(${JSON.stringify(output)})`, { effects: effects as Recipe["effects"] })], async (session, dir) => {
      expect(await session.extensionRunner!.emitToolCall(call)).toBeUndefined();
      expect((await status(session)).runtime.lastFailure).toContain(reason);
      const records = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(records).toContainEqual(expect.objectContaining({ moduleId: "recipe:refusal", provider: "action-engine", decision: "module-failure", reason: "[REDACTED]" }));
    });
  });

  it("short-circuits a Recipe block behind a Policy Engine denial", async () => {
    await withRecipes([recipe("must-not-run", "tool_call", "require('fs').writeFileSync('ran','yes')")], async (session, dir) => {
      expect(await session.extensionRunner!.emitToolCall(call)).toMatchObject({ block: true, reason: expect.stringContaining("policy-deny") });
      await expect(readFile(join(dir, "ran"))).rejects.toMatchObject({ code: "ENOENT" });
      const audit = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(audit.filter((record) => record.decision === "deny")).toHaveLength(1);
    }, [{ id: "policy-deny", match: { tool: "bash" }, decision: "deny", scope: "shell", remedy: "read only" }]);
  });

  it("continues fixed commands after ignored failure and skips unmatched tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-recipe-command-"));
    try {
      const configPath = join(dir, "pi-hooks.jsonc");
      await writeFile(configPath, JSON.stringify({ schemaVersion: 2, providers: [{ id: "action-engine", config: { recipes: [{ ...recipe("order", "tool_call", "", { tool: "bash" }), commands: [command("process.exit(2)"), command("require('fs').writeFileSync('continued','yes')")] }] } }] }));
      const host = await createHookHost({ configPath, providers: [actionEngineProvider] });
      await host.dispatch(normalizeEvent("tool_call", { toolName: "read", input: {} }), { cwd: dir, hasUI: false });
      await expect(readFile(join(dir, "continued"))).rejects.toMatchObject({ code: "ENOENT" });
      await host.dispatch(normalizeEvent("tool_call", call), { cwd: dir, hasUI: false });
      expect(await readFile(join(dir, "continued"), "utf8")).toBe("yes");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

function transformedPolicyExtension(): string {
  return `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { actionEngineProvider, createPiHooksExtension, defineProvider, policyEngineProvider } from ${JSON.stringify(hooksIndexPath)};

const hostTransform = defineProvider({
  manifest: { id: "host-transform", version: "1.0.0", grants: ["events"] },
  activate(facade) {
    facade.events.registerModule({
      id: "host-transform",
      tool_call: {
        transform: () => ({ input: { command: "denied after transform" } }),
        observe: ({ context, contextAdditions }) => writeFileSync(join(context.cwd, "observed-context.json"), JSON.stringify(contextAdditions)),
      },
    });
  },
});

export default createPiHooksExtension({ providers: [actionEngineProvider, hostTransform, policyEngineProvider] });
`;
}

describe("Recipe child lifecycle", () => {
  it("reports spawn errors and cancellation", async () => {
    const spec = { command: "no-such-hook-command", cwd: process.cwd(), stdin: "{}", timeoutMs: 3000 };
    await expect(runProcess(spec)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runProcess({ ...spec, ...command("setInterval(()=>{},1000)"), signal: AbortSignal.abort() })).rejects.toThrow("aborted");
  });

  it.runIf(process.platform !== "win32").each(["ignore", "block"] as const)(
    "aborts an active Pi turn Recipe process group with onFailure %s",
    async (onFailure) => {
      const timeoutMs = 5000;
      await withRecipes([
        recipe("active-cancel", "tool_call", activeProcessTreeScript("active-process.json"), { timeoutMs, onFailure }),
      ], async (session, dir) => {
        const run = runActiveToolTurn(session);
        let pids: { leader: number; descendant: number } | undefined;
        try {
          pids = await readJsonWhenReady(join(dir, "active-process.json"), timeoutMs);
          expect(session.isIdle).toBe(false);
          expect(await processGroupId(pids.leader)).toBe(pids.leader);
          expect(await processGroupId(pids.descendant)).toBe(pids.leader);
          expect(isProcessAlive(pids.leader)).toBe(true);
          expect(isProcessAlive(pids.descendant)).toBe(true);

          await session.abort();
          await run;

          await waitForProcessExit(pids.leader, timeoutMs);
          await waitForProcessExit(pids.descendant, timeoutMs);
          expect(isProcessAlive(pids.leader)).toBe(false);
          expect(isProcessAlive(pids.descendant)).toBe(false);

          const currentStatus = await status(session);
          expect(currentStatus.runtime).toMatchObject({
            health: "degraded",
            lastFailure: expect.stringContaining("Recipe active-cancel: command aborted"),
          });
          expect(currentStatus.providers).toContainEqual(expect.objectContaining({
            id: "action-engine",
            health: "degraded",
            lastFailure: expect.stringContaining("Recipe active-cancel: command aborted"),
          }));

          const audit = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
          expect(audit).toContainEqual(expect.objectContaining({
            moduleId: "recipe:active-cancel",
            provider: "action-engine",
            eventType: "tool_call",
            phase: "guard",
            decision: "module-failure",
            reason: "[REDACTED]",
          }));
          expect(audit).toContainEqual(expect.objectContaining({
            moduleId: onFailure === "block" ? "recipe:active-cancel" : "host",
            eventType: "tool_call",
            decision: onFailure === "block" ? "deny" : "allow",
          }));
        } finally {
          if (!session.isIdle) await session.abort();
          await run.catch(() => undefined);
          if (pids) killProcessGroup(pids.leader);
        }
      });
    },
    30_000,
  );
});

const activeModel = {
  id: "active-recipe-test",
  name: "Active Recipe Test",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://scripted.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
};

async function runActiveToolTurn(session: AgentSession): Promise<void> {
  let turn = 0;
  await session.modelRuntime.setRuntimeApiKey("anthropic", "scripted-local-key");
  session.agent.state.model = activeModel as never;
  session.agent.streamFunction = (() => {
    turn += 1;
    const stopReason = turn === 1 ? "toolUse" : "stop";
    const message = {
      role: "assistant",
      content: turn === 1
        ? [{ type: "toolCall", id: "active-recipe-call", name: "read", arguments: { path: hooksIndexPath } }]
        : [{ type: "text", text: "done" }],
      api: activeModel.api,
      provider: activeModel.provider,
      model: activeModel.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: Date.now(),
    };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: message };
        yield { type: "done", reason: stopReason, message };
      },
      result: async () => message,
    };
  }) as never;
  await session.prompt("start the Recipe");
}

function activeProcessTreeScript(handshakeFile: string): string {
  return `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(handshakeFile)}, JSON.stringify({ leader: process.pid, descendant: descendant.pid }));
setInterval(() => {}, 1000);
`;
}

async function readJsonWhenReady(path: string, timeoutMs: number): Promise<{ leader: number; descendant: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`process handshake did not appear within ${timeoutMs}ms`);
}

async function processGroupId(pid: number): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)]);
  return Number(stdout.trim());
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (isProcessAlive(pid)) throw new Error(`process ${pid} remained alive after ${timeoutMs}ms`);
}

function killProcessGroup(leader: number): void {
  try { process.kill(-leader, "SIGKILL"); } catch { /* The group is already gone. */ }
}
