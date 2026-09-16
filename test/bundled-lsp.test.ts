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
      const fromLsp = createRequire(join(packageDir, "node_modules/@ian-pascoe/pi-lsp/package.json"));
      for (const dependency of ["cross-spawn", "proper-lockfile", "vscode-languageserver-protocol/node"]) {
        expect(fromLsp.resolve(dependency)).toContain(dir);
        console.log(`Bundled dependency: ${dependency} -> ${fromLsp.resolve(dependency)}`);
      }
      await writeFile(join(dir, "settings.json"), JSON.stringify({ packages: [packageDir], lsp: { servers: { typescript: {
        command: "tsgo", args: ["--lsp", "--stdio"], languages: [{ extensions: [".ts"], languageId: "typescript" }], rootMarkers: ["tsconfig.json"], requireRootMarker: true,
      } } } }));
      await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["example.ts"] }));
      const file = join(dir, "example.ts");
      await writeFile(file, 'const value: number = "deliberate error";\n');
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      expect(loader.getSkills().skills.some((skill) => skill.name === "pi-lsp")).toBe(true);
      const { session } = await createAgentSession({ cwd: dir, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
      try {
        await session.bindExtensions({});
        expect(session.getAllTools().filter((tool) => tool.name === "lsp")).toHaveLength(1);
        expect(session.extensionRunner!.getCommand("lsp")).toBeDefined();
        const status = await callTool(session, "lsp", { operation: "status" });
        expect(JSON.stringify(status.content)).toContain("typescript");
        const diagnostic = await callTool(session, "lsp", { operation: "diagnostics", file_path: file });
        expect(JSON.stringify(diagnostic.content)).toContain("not assignable");
        await callTool(session, "edit", { path: file, edits: [{ oldText: '"deliberate error"', newText: "42" }] });
        const edit = await callTool(session, "edit", { path: file, edits: [{ oldText: "42", newText: '"another error"' }] });
        expect(JSON.stringify(edit.content)).toContain("not assignable");
        expect(await readFile(file, "utf8")).toContain('"another error"');
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
