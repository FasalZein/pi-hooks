import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

async function callTool(
  session: AgentSession,
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const runner = session.extensionRunner!;
  const tool = session.getToolDefinition(name)!;
  const prepared = tool.prepareArguments?.(input) ?? input;
  const event = { type: "tool_call", toolName: name, toolCallId: `live-${name}-${Math.random()}`, input: prepared };
  const boundaryResult = await runner.emitToolCall(event as never);
  expect(boundaryResult, JSON.stringify(boundaryResult)).toBeUndefined();
  const result = await tool.execute(event.toolCallId, event.input, signal, undefined, runner.createContext());
  const patch = await runner.emitToolResult({ type: "tool_result", toolName: name, toolCallId: event.toolCallId, input: event.input, ...result, isError: false } as never);
  return { ...result, ...patch };
}

async function prepareToolCall(session: AgentSession, name: string, input: Record<string, unknown>) {
  const tool = session.getToolDefinition(name)!;
  const prepared = tool.prepareArguments?.(input) ?? input;
  const event = { type: "tool_call", toolName: name, toolCallId: `live-${name}-${Math.random()}`, input: prepared };
  const boundaryResult = await session.extensionRunner!.emitToolCall(event as never);
  return { tool, event, boundaryResult };
}

describe("bundled pi-lsp go/no-go", () => {
  it("loads one packed LSP, resolves its dependencies, and attaches live TypeScript diagnostics after edit", async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-hooks-lsp-bundle-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const { stdout } = await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], { cwd: root });
      const [{ filename }] = JSON.parse(stdout);
      await exec("npm", ["install", join(dir, filename), "--ignore-scripts", "--legacy-peer-deps", "--omit=peer", "--no-audit", "--no-fund"], { cwd: dir });
      const packageDir = join(dir, "node_modules/@tothemoon/pi-hooks");
      const { stdout: tsgoVersion } = await exec("tsgo", ["--version"]);
      expect(tsgoVersion).toContain("7.0.0-dev.20260707.2");
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
      await writeFile(join(dir, "pi-hooks.jsonc"), "// unified configuration\n" + JSON.stringify({
        schemaVersion: 2,
        providers: [{ id: "policy-engine", enabled: true, config: { rules: [{
          id: "approve-lsp-apply",
          match: { tool: "lsp", input: { operation: { equals: "apply" } } },
          decision: "ask",
          scope: "workspace edit",
          remedy: "reject the preview",
        }] } }],
        lsp: { servers: {
          broken: { enabled: "sometimes", command: "must-not-run", languages: [{ extensions: [".broken"], languageId: "broken" }] },
          typescript: {
            command: "tsgo", args: ["--lsp", "--stdio"], languages: [{ extensions: [".ts"], languageId: "typescript" }], rootMarkers: ["tsconfig.json"], requireRootMarker: true,
          },
        } },
      }));
      await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["**/*.ts"] }));
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
      const approvalPrompts: string[] = [];
      const approvalAnswers: boolean[] = [];
      try {
        await session.bindExtensions({ mode: "rpc", uiContext: {
          notify: (message: string, level: string) => notifications.push({ message, level }),
          confirm: async (_title: string, message: string) => {
            approvalPrompts.push(message);
            return approvalAnswers.shift() ?? false;
          },
          select: async (_title: string, options: string[]) => {
            scopeChoices.push(options);
            const selected = selectedValues.shift();
            return selected === "<typescript>" ? options.find((option) => option.startsWith("typescript —")) : selected;
          },
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

        const capabilities = await callTool(session, "lsp", { operation: "capabilities", server_id: "typescript", file_path: file });
        expect(JSON.stringify(capabilities.content)).toContain("documentFormattingProvider");
        expect(JSON.stringify(capabilities.content)).toContain("renameProvider");
        await expect(callTool(session, "lsp", { operation: "document_colors", file_path: file, server_id: "typescript" }))
          .rejects.toThrow("server typescript does not support the requested operation");

        const unformatted = 'const value:number="another error"\n';
        await writeFile(file, unformatted);
        const formatPreview = await callTool(session, "lsp", {
          operation: "format_document", file_path: file, server_id: "typescript", tab_size: 2, insert_spaces: true,
        });
        const formatDetails = formatPreview.details as { preview_id: string; mutation_manifest: unknown[]; state: string };
        expect(formatDetails.state).toBe("available");
        expect(formatDetails.mutation_manifest).toEqual([expect.objectContaining({ operation: "modify", path: expect.stringMatching(/example\.ts$/) })]);
        expect(await readFile(file, "utf8")).toBe(unformatted);
        approvalAnswers.push(true);
        const formatApply = await callTool(session, "lsp", { operation: "apply", preview_id: formatDetails.preview_id });
        const formatted = await readFile(file, "utf8");
        expect(formatted).not.toBe(unformatted);
        expect(formatted).toContain('const value: number = "another error"');
        expect(JSON.stringify(formatApply.content)).toContain("LSP diagnostics");
        expect(approvalPrompts.at(-1)).toContain("example.ts");

        await writeFile(file, unformatted);
        const deniedPreview = await callTool(session, "lsp", {
          operation: "format_document", file_path: file, server_id: "typescript", tab_size: 2, insert_spaces: true,
        });
        const deniedId = (deniedPreview.details as { preview_id: string }).preview_id;
        approvalAnswers.push(false);
        const denied = await prepareToolCall(session, "lsp", { operation: "apply", preview_id: deniedId });
        expect(denied.boundaryResult).toMatchObject({ block: true, reason: expect.stringContaining("approve-lsp-apply") });
        expect(await readFile(file, "utf8")).toBe(unformatted);

        approvalAnswers.push(true);
        const changedManifest = await prepareToolCall(session, "lsp", { operation: "apply", preview_id: deniedId });
        expect(changedManifest.boundaryResult).toBeUndefined();
        expect(changedManifest.event.input).toMatchObject({ mutation_manifest: [{ operation: "modify", path: expect.stringMatching(/example\.ts$/) }] });
        (changedManifest.event.input as Record<string, unknown>).mutation_manifest = [];
        await expect(changedManifest.tool.execute(
          changedManifest.event.toolCallId,
          changedManifest.event.input,
          undefined,
          undefined,
          session.extensionRunner!.createContext(),
        )).rejects.toThrow("Mutation Manifest changed after argument preparation");
        expect(await readFile(file, "utf8")).toBe(unformatted);

        const cancelledPreview = await callTool(session, "lsp", {
          operation: "format_document", file_path: file, server_id: "typescript", tab_size: 2, insert_spaces: true,
        });
        const cancelledId = (cancelledPreview.details as { preview_id: string }).preview_id;
        const cancellation = new AbortController();
        cancellation.abort();
        approvalAnswers.push(true);
        await expect(callTool(session, "lsp", { operation: "apply", preview_id: cancelledId }, cancellation.signal))
          .rejects.toThrow("Workspace Edit cancelled before its first mutation");
        expect(await readFile(file, "utf8")).toBe(unformatted);

        const firstDir = join(dir, "a");
        const secondDir = join(dir, "z");
        await mkdir(firstDir);
        await mkdir(secondDir);
        const firstFile = join(firstDir, "first.ts");
        const secondFile = join(secondDir, "second.ts");
        const firstOriginal = "export const sharedName: number = 1;\n";
        const secondOriginal = 'import { sharedName } from "../a/first";\nexport const answer = sharedName;\n';
        await writeFile(firstFile, firstOriginal);
        await writeFile(secondFile, secondOriginal);
        const preparedRename = await callTool(session, "lsp", {
          operation: "prepare_rename", file_path: firstFile, server_id: "typescript", line: 1, character: 14,
        });
        expect(JSON.stringify(preparedRename.content)).toContain("sharedName");
        const renamePreview = await callTool(session, "lsp", {
          operation: "rename", file_path: firstFile, server_id: "typescript", line: 1, character: 14, new_name: "renamedValue",
        });
        const renameDetails = renamePreview.details as { preview_id: string; mutation_manifest: Array<{ path: string }> };
        expect(renameDetails.mutation_manifest.map(({ path }) => path.replace(/^.*\/(a|z)\//, "$1/")).sort()).toEqual(["a/first.ts", "z/second.ts"]);
        expect(await readFile(firstFile, "utf8")).toBe(firstOriginal);
        expect(await readFile(secondFile, "utf8")).toBe(secondOriginal);
        await chmod(secondDir, 0o555);
        try {
          approvalAnswers.push(true);
          await expect(callTool(session, "lsp", { operation: "apply", preview_id: renameDetails.preview_id }))
            .rejects.toThrow("Workspace Edit failed and was rolled back");
        } finally {
          await chmod(secondDir, 0o755);
        }
        expect(await readFile(firstFile, "utf8")).toBe(firstOriginal);
        expect(await readFile(secondFile, "utf8")).toBe(secondOriginal);

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
