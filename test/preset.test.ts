import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("path-installed Preset", () => {
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
        expect(JSON.parse(notices[0])).toMatchObject({ activation: "active", preset: "pi-hooks", providers: [expect.objectContaining({ id: "policy-engine", enabled: true })] });
        expect(await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "default", input: { command: "echo allowed" } } as never)).toBeUndefined();
      } finally { session.dispose(); }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
