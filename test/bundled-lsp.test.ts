import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

async function callTool(session: AgentSession, name: string, input: Record<string, unknown>) {
  const runner = session.extensionRunner!;
  const event = { type: "tool_call", toolName: name, toolCallId: `live-${name}`, input };
  expect(await runner.emitToolCall(event as never)).toBeUndefined();
  const result = await session.getToolDefinition(name)!.execute(event.toolCallId, input, undefined, undefined, runner.createContext());
  const patch = await runner.emitToolResult({ type: "tool_result", toolName: name, toolCallId: event.toolCallId, input, ...result, isError: false } as never);
  return { ...result, ...patch };
}

describe("bundled pi-lsp go/no-go", () => {
  it("loads one packed LSP, resolves its dependencies, and attaches live TypeScript diagnostics after edit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-lsp-bundle-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const { stdout } = await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], { cwd: root });
      const [{ filename }] = JSON.parse(stdout);
      await exec("npm", ["install", join(dir, filename), "--ignore-scripts", "--legacy-peer-deps", "--omit=peer", "--no-audit", "--no-fund"], { cwd: dir });
      const packageDir = join(dir, "node_modules/@tothemoon/pi-hooks");
      const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
      expect(manifest.dependencies["@ian-pascoe/pi-lsp"]).toBe("0.4.4");
      for (const resource of [...manifest.pi.extensions, ...manifest.pi.skills.map((path: string) => `${path}/pi-lsp/SKILL.md`)]) {
        expect(await readFile(join(packageDir, resource), "utf8")).not.toBe("");
      }
      const packedSkill = await readFile(join(packageDir, "skills/pi-lsp/SKILL.md"), "utf8");
      const packedGuide = await readFile(join(packageDir, "README.md"), "utf8");
      expect(packedSkill).toContain("pi-hooks.jsonc");
      expect(packedSkill).toContain("../../README.md");
      expect(packedSkill).not.toContain("settings.json");
      expect(packedSkill).not.toContain("project settings");
      expect(packedGuide).toContain("session override → `lsp.enablement` → definition-level `enabled` → enabled by default");
      expect(packedGuide).toContain("Reload Pi after changing a Server Definition");
      const fromLsp = createRequire(join(packageDir, "node_modules/@ian-pascoe/pi-lsp/package.json"));
      for (const dependency of ["cross-spawn", "proper-lockfile", "vscode-languageserver-protocol/node"]) {
        expect(fromLsp.resolve(dependency)).toContain(dir);
        console.log(`Bundled dependency: ${dependency} -> ${fromLsp.resolve(dependency)}`);
      }
      await writeFile(join(dir, "settings.json"), JSON.stringify({ packages: [packageDir] }));
      await writeFile(join(dir, "pi-hooks.jsonc"), "// unified configuration\n" + JSON.stringify({ schemaVersion: 2, lsp: { servers: {
        broken: { enabled: "sometimes", command: "must-not-run", languages: [{ extensions: [".broken"], languageId: "broken" }] },
        typescript: {
          command: "tsgo", args: ["--lsp", "--stdio"], languages: [{ extensions: [".ts"], languageId: "typescript" }], rootMarkers: ["tsconfig.json"], requireRootMarker: true,
        },
      } } }));
      await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["example.ts"] }));
      const file = join(dir, "example.ts");
      await writeFile(file, 'const value: number = "deliberate error";\n');
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      expect(loader.getSkills().skills.some((skill) => skill.name === "pi-lsp")).toBe(true);
      const { session } = await createAgentSession({ cwd: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
      const notifications: Array<{ message: string; level: string }> = [];
      const scopeChoices: string[][] = [];
      const selectedValues: string[] = [];
      try {
        await session.bindExtensions({ uiContext: {
          notify: (message: string, level: string) => notifications.push({ message, level }),
          select: async (_title: string, options: string[]) => {
            scopeChoices.push(options);
            const selected = selectedValues.shift();
            return selected === "<typescript>" ? options.find((option) => option.startsWith("typescript —")) : selected;
          },
          setStatus() {},
        } as never });
        expect(notifications.some(({ message, level }) => level === "warning" && message.includes("global lsp.servers.broken.enabled"))).toBe(true);
        expect(session.getAllTools().filter((tool) => tool.name === "lsp")).toHaveLength(1);
        expect(session.extensionRunner!.getCommand("lsp")).toBeDefined();
        const status = await callTool(session, "lsp", { operation: "status" });
        expect(JSON.stringify(status.content)).toContain("typescript");
        expect(JSON.stringify(status.content)).not.toContain("must-not-run");
        const diagnostic = await callTool(session, "lsp", { operation: "diagnostics", file_path: file });
        expect(JSON.stringify(diagnostic.content)).toContain("not assignable");
        await callTool(session, "edit", { path: file, edits: [{ oldText: '"deliberate error"', newText: "42" }] });
        const edit = await callTool(session, "edit", { path: file, edits: [{ oldText: "42", newText: '"another error"' }] });
        expect(JSON.stringify(edit.content)).toContain("not assignable");
        expect(await readFile(file, "utf8")).toContain('"another error"');
        const runner = session.extensionRunner!;
        const lspCommand = runner.getCommand("lsp")!;
        const beforeCommandStatus = notifications.length;
        await lspCommand.handler("status", runner.createContext() as never);
        expect(notifications.slice(beforeCommandStatus).some(({ message }) => message.includes("typescript —"))).toBe(true);
        const beforeHeadlessChoices = scopeChoices.length;
        const headlessContext = runner.createContext();
        Object.defineProperty(headlessContext, "hasUI", { value: false });
        await lspCommand.handler("", headlessContext as never);
        expect(scopeChoices).toHaveLength(beforeHeadlessChoices);
        const completions = await lspCommand.getArgumentCompletions?.("disable typescript ");
        expect(completions?.map(({ label }) => label)).toEqual(["--global"]);
        selectedValues.push("<typescript>", "disable", "session");
        await lspCommand.handler("", runner.createContext() as never);
        expect(scopeChoices).toContainEqual(["session", "global"]);
        const beforeProject = await readFile(join(dir, "pi-hooks.jsonc"), "utf8");
        const projectNotification = notifications.length;
        await lspCommand.handler("disable typescript --project", runner.createContext() as never);
        expect(await readFile(join(dir, "pi-hooks.jsonc"), "utf8")).toBe(beforeProject);
        expect(notifications.slice(projectNotification).some(({ message }) => message.includes("Use --global or a session-scoped LSP toggle"))).toBe(true);
        await lspCommand.handler("disable typescript --global", runner.createContext() as never);
        const disabled = await readFile(join(dir, "pi-hooks.jsonc"), "utf8");
        expect(disabled).toContain("// unified configuration");
        expect(disabled).toContain('"typescript": false');
        expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))).not.toHaveProperty("lsp");
        expect(JSON.stringify((await callTool(session, "lsp", { operation: "status" })).content)).toContain("disabled");
        await lspCommand.handler("enable typescript --global", runner.createContext() as never);
        await lspCommand.handler("disable typescript", runner.createContext() as never);
        expect(JSON.stringify((await callTool(session, "lsp", { operation: "status" })).content)).toContain("disabled");
        expect(await readFile(join(dir, "pi-hooks.jsonc"), "utf8")).toContain('"typescript": true');
        await runner.emit({ type: "session_shutdown", reason: "quit" });
        const fresh = await createAgentSession({ cwd: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
        try {
          await fresh.session.bindExtensions({});
          expect(fresh.session.getAllTools().filter((tool) => tool.name === "lsp")).toHaveLength(1);
          expect(JSON.stringify((await callTool(fresh.session, "lsp", { operation: "diagnostics", file_path: file })).content)).toContain("not assignable");
        } finally {
          await fresh.session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
          fresh.session.dispose();
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
  }, 60_000);
});
