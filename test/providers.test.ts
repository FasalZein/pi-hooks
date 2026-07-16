import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const hooksIndexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

async function withProviderSession<T>(
  options: { config: string; extensionSource: string },
  run: (session: AgentSession, agentDir: string) => Promise<T>,
): Promise<T> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-hooks-providers-"));
  await writeFile(join(agentDir, "pi-hooks.jsonc"), options.config);
  const extraPath = join(agentDir, "provider-extension.ts");
  await writeFile(extraPath, options.extensionSource);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      additionalExtensionPaths: [extraPath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({ resourceLoader: loader, sessionManager: SessionManager.inMemory() });
    try {
      return await run(session, agentDir);
    } finally {
      session.dispose();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

/** A globally authorized provider declaring the tools grant registers a real Pi tool. */
function toolProviderSource(markerPath: string): string {
  return `
import { Type } from "typebox";
import { writeFile } from "node:fs/promises";
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};

const greeter = defineProvider({
  manifest: { id: "greeter", version: "1.0.0", grants: ["tools"] },
  activate(facade) {
    facade.tools.registerTool({
      name: "greet",
      label: "Greet",
      description: "Writes a greeting marker to prove provider tool execution",
      parameters: Type.Object({ who: Type.String() }),
      async execute(_id, params) {
        await writeFile(${JSON.stringify(markerPath)}, "greeted:" + params.who);
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
  },
});

export default createPiHooksExtension({ providers: [greeter] });
`;
}

/** A provider without the tools grant that casts around the type and calls registerTool anyway. */
function ungrantedToolSource(auditPath: string): string {
  return `
import { Type } from "typebox";
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};

const sneaky = defineProvider({
  manifest: { id: "sneaky", version: "1.0.0", grants: ["events"] },
  activate(facade) {
    // Dynamically-loaded providers can cast around the type boundary; the Host
    // must back the type refusal at runtime.
    (facade as any).tools.registerTool({
      name: "sneaky-tool",
      label: "Sneaky",
      description: "should never be registered",
      parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text", text: "no" }] }; },
    });
  },
});

export default createPiHooksExtension({ providers: [sneaky] });
`;
}

describe("SLICE-0009 AC1: tools grant registration and refusal at the real seam", () => {
  it("registers and executes a provider tool when the tools grant is declared", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-marker-")), "greet.txt");
    const config = JSON.stringify({ schemaVersion: 2, providers: [{ id: "greeter", enabled: true }] });
    await withProviderSession({ config, extensionSource: toolProviderSource(markerPath) }, async (session) => {
      const info = session.getAllTools().find((tool) => tool.name === "greet");
      expect(info).toBeDefined();
      expect(info?.sourceInfo.source).not.toBe("builtin");

      const def = session.getToolDefinition("greet");
      expect(def).toBeDefined();
      await def!.execute("call-1", { who: "world" } as never, undefined, undefined, {} as never);
      expect(await readFile(markerPath, "utf8")).toBe("greeted:world");
    });
  }, 30_000);

  it("refuses an undeclared tools grant at runtime with an audited provider-attributed refusal", async () => {
    const auditDir = await mkdtemp(join(tmpdir(), "pi-hooks-refuse-audit-"));
    const auditPath = join(auditDir, "audit.jsonl");
    const config = JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "sneaky", enabled: true }],
      audit: { path: auditPath, includeAllows: false },
    });
    await withProviderSession({ config, extensionSource: ungrantedToolSource(auditPath) }, async (session) => {
      // The tool never reaches Pi's registry.
      expect(session.getAllTools().find((tool) => tool.name === "sneaky-tool")).toBeUndefined();
      expect(session.getToolDefinition("sneaky-tool")).toBeUndefined();

      const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const refusal = lines.find((line) => line.decision === "grant-refused");
      expect(refusal).toBeDefined();
      expect(refusal.provider).toBe("sneaky");
    });
  }, 30_000);
});
