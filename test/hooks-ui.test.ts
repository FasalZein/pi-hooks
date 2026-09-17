import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, type CustomEntry, type ExtensionUIContext, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { approvalPanel, statusPanel, statusText } from "../src/hooks-ui.js";
import { createHookHost, policyEngineProvider, normalizeEvent } from "../src/index.js";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const request = { title: "Policy Engine approval", message: "Command: rm file\nRule: danger-01\nScope: deletion\nRemedy: use read" };
const entry = fileURLToPath(new URL("../src/preset.ts", import.meta.url));

function isDenialEntry(entry: SessionEntry): entry is CustomEntry<{ reason: string }> {
  return entry.type === "custom" && "customType" in entry && entry.customType === "pi-hooks-denial"
    && typeof entry.data === "object" && entry.data !== null && "reason" in entry.data && typeof entry.data.reason === "string";
}

describe("Hooks TUI", () => {
  it("renders every status field at 80 columns and supports scrolling and dismissal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-ui-status-"));
    try {
      const host = await createHookHost({ configPath: join(dir, "missing.jsonc") });
      const done = vi.fn();
      const panel = statusPanel(host.status(), theme, done, () => 8);
      expect(statusText(host.status())).toContain("Preset: Bare Host");
      const first = panel.render(80);
      expect(first.join("\n")).toContain("Hooks: active");
      panel.handleInput?.("\x1b[B");
      expect(panel.render(80)).not.toEqual(first);
      panel.handleInput?.("\x1b[A");
      expect(panel.render(80)).toEqual(first);
      panel.invalidate();
      expect(panel.render(80).every((line) => visibleWidth(line) <= 80)).toBe(true);
      panel.handleInput?.("\r");
      expect(done).toHaveBeenCalledOnce();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("defaults an omitted rendering key to the interactive /hooks status panel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-ui-default-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      await writeFile(join(dir, "pi-hooks.jsonc"), JSON.stringify({ schemaVersion: 2 }));
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({ cwd: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
      try {
        const panels: string[] = [];
        const notifications: string[] = [];
        const custom: ExtensionUIContext["custom"] = async (factory) => new Promise((resolve) => {
          const component = factory({ requestRender() {}, terminal: { rows: 30 } } as never, theme, {} as never, resolve) as Component;
          panels.push(component.render(80).join("\n"));
          component.handleInput?.("\r");
        });
        await session.bindExtensions({ uiContext: { custom, notify: (text: string) => notifications.push(text), setStatus() {} } as never });
        await session.prompt("/hooks status");
        expect(panels).toHaveLength(1);
        expect(panels[0]).toContain("Hooks: active");
        expect(panels[0]).toContain("Preset: pi-hooks");
        expect(notifications).toEqual([]);
      } finally { session.dispose(); }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [["\r"], false], [["\x1b[B", "\r"], true], [["\x1b"], false], [["\x03"], false],
  ] as const)("approval keys %j resolve as %s", (keys, answer) => {
    const done = vi.fn();
    const panel = approvalPanel(request, theme, done);
    const lines = panel.render(80);
    for (const label of ["Command: rm file", "Rule: danger-01", "Scope: deletion", "Remedy: use read", "Allow once", "Deny"]) {
      expect(lines.join("\n")).toContain(label);
    }
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    panel.invalidate();
    for (const key of keys) panel.handleInput?.(key);
    expect(done).toHaveBeenCalledWith(answer);
  });

  it.each([true, false])("rendering=%s preserves decisions and redacted audit outcomes through Pi", async (answer) => {
    const outcomes: unknown[] = [];
    for (const rendering of [true, false]) {
      const dir = await mkdtemp(join(tmpdir(), "pi-hooks-ui-parity-"));
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = dir;
      try {
        const auditPath = join(dir, "audit.jsonl");
        await writeFile(join(dir, "pi-hooks.jsonc"), JSON.stringify({ schemaVersion: 2, rendering, audit: { path: auditPath, includeAllows: true }, providers: [
          { id: "policy-engine", config: { rules: [{ id: "ask-shell", match: { tool: "bash" }, decision: "ask", scope: "shell", remedy: "approve once" }] } },
        ] }));
        const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
        await loader.reload();
        expect(loader.getExtensions().errors).toEqual([]);
        const { session } = await createAgentSession({ cwd: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
        try {
          const panels: string[] = [];
          const notifications: string[] = [];
          let showingStatus = true;
          const custom: ExtensionUIContext["custom"] = async (factory) => new Promise((resolve) => {
            const component = factory({ requestRender() {}, terminal: { rows: 30 } } as never, theme, {} as never, resolve) as Component;
            panels.push(component.render(80).join("\n"));
            if (!showingStatus && answer) component.handleInput?.("\x1b[B");
            component.handleInput?.("\r");
          });
          const confirm = vi.fn(async () => answer);
          const ui = { custom, confirm, notify: (text: string) => notifications.push(text), setStatus() {} } as never;
          await session.bindExtensions({ uiContext: ui });
          await session.extensionRunner!.getCommand("hooks")!.handler("status", session.extensionRunner!.createContext() as never);
          if (rendering) expect(panels[0]).toContain("Preset: pi-hooks");
          else expect(JSON.parse(notifications[0]).rendering).toBe(false);
          showingStatus = false;
          const result = await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "parity", input: { command: "echo exact" } });
          if (answer) expect(result).toBeUndefined();
          else expect(result).toMatchObject({ block: true, reason: expect.stringContaining("ask-shell") });
          expect(confirm).toHaveBeenCalledTimes(rendering ? 0 : 1);
          const denialEntries = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-hooks-denial");
          expect(denialEntries).toHaveLength(rendering && !answer ? 1 : 0);
          if (rendering) expect(panels.at(-1)).toContain("Command: echo exact");
          const records = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => {
            const record = JSON.parse(line);
            delete record.timestamp;
            delete record.sessionId;
            return record;
          });
          outcomes.push({ result, records });
        } finally { session.dispose(); }
      } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(dir, { recursive: true, force: true });
      }
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
  });

  it("uses the native dialog rather than terminal components in RPC mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-rpc-"));
    try {
      const configPath = join(dir, "pi-hooks.jsonc");
      await writeFile(configPath, JSON.stringify({ schemaVersion: 2, providers: [{ id: "policy-engine", config: { rules: [{ id: "ask", match: { tool: "bash" }, decision: "ask", scope: "shell", remedy: "approve once" }] } }] }));
      const host = await createHookHost({ configPath, preset: "pi-hooks", providers: [policyEngineProvider] });
      const custom = vi.fn(async () => { throw new Error("terminal UI unavailable in RPC"); });
      const confirm = vi.fn(async () => true);
      const result = await host.dispatch(normalizeEvent("tool_call", { toolName: "bash", toolCallId: "rpc", input: { command: "echo ok" } }), { cwd: dir, mode: "rpc", hasUI: true, ui: { setStatus() {}, confirm, custom: custom as never } });
      expect(result.decision).toBe("allow");
      expect(confirm).toHaveBeenCalledOnce();
      expect(custom).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("renders a live Recipe block through the registered policy denial surface", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-ui-recipe-denial-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const originalReason = "use read instead";
      await writeFile(join(dir, "pi-hooks.jsonc"), JSON.stringify({
        schemaVersion: 2,
        rules: [{ id: "policy-block", match: { tool: "read" }, decision: "deny", scope: "test", remedy: "use another fixture" }],
        recipes: [{
          id: "ui-block", event: "tool_call", tool: "bash", timeoutMs: 3000, effects: ["block"],
          commands: [{ command: process.execPath, args: ["-e", `process.stdout.write(JSON.stringify({type:"block",reason:${JSON.stringify(originalReason)}}))`] }],
        }],
      }));
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({ cwd: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
      try {
        await session.bindExtensions({ uiContext: { notify() {}, setStatus() {} } as never });
        const recipeResult = await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "recipe-ui", input: { command: "echo harmless" } });
        expect(recipeResult).toEqual({ block: true, reason: `Recipe ui-block: ${originalReason}` });

        const recipeEntries = session.sessionManager.getEntries().filter(isDenialEntry);
        expect(recipeEntries).toHaveLength(1);
        expect(recipeEntries[0].data).toEqual({ reason: `Recipe ui-block: ${originalReason}` });

        const renderer = session.extensionRunner!.getEntryRenderer("pi-hooks-denial");
        expect(renderer).toBeDefined();
        const styledTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as Theme;
        const recipePanel = renderer!(recipeEntries[0], { expanded: false }, styledTheme)!;
        const recipeLines = recipePanel.render(80);
        expect(recipeLines.join("\n")).toContain("<error>Hooks denied this call</error>");
        expect(recipeLines.join("\n")).toContain(originalReason);
        expect(recipeLines.every((line) => visibleWidth(line) <= 80)).toBe(true);

        const policyResult = await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "policy-ui", input: { path: "harmless.txt" } });
        expect(policyResult).toMatchObject({ block: true, reason: expect.stringContaining("policy-block") });
        const allEntries = session.sessionManager.getEntries().filter(isDenialEntry);
        expect(allEntries).toHaveLength(2);
        const policyPanel = renderer!(allEntries[1], { expanded: false }, styledTheme)!;
        expect(policyPanel.render(80)[0]).toBe(recipeLines[0]);
      } finally { session.dispose(); }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
