import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const hooksIndexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Direct dispatch seam (see .ralph/plan.md "Test seams"): proves decision shape
 * and reason content only — it never executes the tool. */
async function withInteractionSession<T>(
  options: { config: string; extensionSource: string },
  run: (session: AgentSession) => Promise<T>,
): Promise<T> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-hooks-interaction-"));
  await writeFile(join(agentDir, "pi-hooks.jsonc"), options.config);
  const extraPath = join(agentDir, "interaction-extension.ts");
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
      return await run(session);
    } finally {
      session.dispose();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

async function emitToolCall(session: AgentSession, toolName: string, input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined> {
  return (await session.extensionRunner!.emitToolCall({
    type: "tool_call",
    toolName,
    toolCallId: `tc-${toolName}-${Math.random().toString(36).slice(2)}`,
    input,
  } as never)) as { block?: boolean; reason?: string } | undefined;
}

/** A provider declaring the interaction grant: its guard asks confirm on every
 * bash tool_call and surfaces the resolved outcome in the deny reason. */
function askerSource(): string {
  return `
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};

const asker = defineProvider({
  manifest: { id: "asker", version: "1.0.0", grants: ["events", "interaction"] },
  activate(facade) {
    facade.events.registerModule({
      id: "asker-mod",
      tool_call: {
        guard: async ({ event }) => {
          if (event.toolName !== "bash") return;
          const outcome = await facade.interaction.confirm(
            { title: "Elevated action", message: "Run bash?" },
            { noUiOutcome: "denied" },
          );
          return { decision: "deny", reason: "confirm-outcome:" + outcome };
        },
      },
    });
  },
});

export default createPiHooksExtension({ providers: [asker] });
`;
}

/** A provider without the interaction grant that casts around the type boundary. */
function ungrantedInteractionSource(): string {
  return `
import { createPiHooksExtension, defineProvider } from ${JSON.stringify(hooksIndexPath)};

const sneakyAsk = defineProvider({
  manifest: { id: "sneaky-ask", version: "1.0.0", grants: ["events"] },
  async activate(facade) {
    // Dynamically-loaded providers can cast around the type boundary; the Host
    // must back the type refusal at runtime.
    await (facade as any).interaction.confirm(
      { title: "sneaky", message: "let me through" },
      { noUiOutcome: "approved" },
    );
  },
});

export default createPiHooksExtension({ providers: [sneakyAsk] });
`;
}

/** Full ExtensionUIContext stub whose confirm records the request and answers. */
function confirmingUiContext(calls: Array<[string, string]>, answer: boolean): unknown {
  return {
    select: async () => undefined,
    confirm: async (title: string, message: string) => {
      calls.push([title, message]);
      return answer;
    },
    input: async () => undefined,
    notify: () => undefined,
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: () => undefined,
  };
}

const askerConfig = JSON.stringify({ schemaVersion: 2, providers: [{ id: "asker", enabled: true }] });

describe("SLICE-0011 item 3: confirm-only interaction grant", () => {
  it("resolves immediately to the caller-supplied noUiOutcome when no UI is attached", async () => {
    await withInteractionSession({ config: askerConfig, extensionSource: askerSource() }, async (session) => {
      // No uiContext bound: the runner reports hasUI=false for this session.
      const result = await emitToolCall(session, "bash", { command: "echo hi" });
      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain("confirm-outcome:denied");
    });
  }, 30_000);

  it("delivers the request to the stubbed ctx.ui.confirm and returns its accepting answer", async () => {
    const calls: Array<[string, string]> = [];
    await withInteractionSession({ config: askerConfig, extensionSource: askerSource() }, async (session) => {
      await session.bindExtensions({ uiContext: confirmingUiContext(calls, true) as never });
      const result = await emitToolCall(session, "bash", { command: "echo hi" });
      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain("confirm-outcome:approved");
      expect(calls).toEqual([["Elevated action", "Run bash?"]]);
    });
  }, 30_000);

  it("returns the stub's rejecting answer as denied", async () => {
    const calls: Array<[string, string]> = [];
    await withInteractionSession({ config: askerConfig, extensionSource: askerSource() }, async (session) => {
      await session.bindExtensions({ uiContext: confirmingUiContext(calls, false) as never });
      const result = await emitToolCall(session, "bash", { command: "echo hi" });
      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain("confirm-outcome:denied");
      expect(calls).toHaveLength(1);
    });
  }, 30_000);

  it("refuses an undeclared interaction grant at runtime with a grant-refused audit record", async () => {
    const auditDir = await mkdtemp(join(tmpdir(), "pi-hooks-interaction-audit-"));
    const auditPath = join(auditDir, "audit.jsonl");
    const config = JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "sneaky-ask", enabled: true }],
      audit: { path: auditPath, includeAllows: false },
    });
    await withInteractionSession({ config, extensionSource: ungrantedInteractionSource() }, async () => {
      const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      // Existing GRANT_KINDS refusal pattern: the persisted audit record carries
      // decision + provider attribution; reasons are always privacy-redacted.
      const refusal = lines.find((line) => line.decision === "grant-refused");
      expect(refusal).toBeDefined();
      expect(refusal.provider).toBe("sneaky-ask");
      // The refusal proxy threw inside activate: the provider's activation
      // failed and was rolled back, leaving a module-failure record too.
      const failure = lines.find((line) => line.decision === "module-failure" && line.provider === "sneaky-ask");
      expect(failure).toBeDefined();
    });
  }, 30_000);
});
