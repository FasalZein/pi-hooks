import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const hooksExtensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const invalidConfig = JSON.stringify({ schemaVersion: 2, modules: [] });

async function withLoadedSession<T>(
  options: { config: string; extraExtensionSource?: string; skipHooksExtension?: boolean },
  run: (session: AgentSession) => Promise<T>,
): Promise<T> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-hooks-adapter-"));
  await writeFile(join(agentDir, "pi-hooks.jsonc"), options.config);
  const additionalExtensionPaths = options.skipHooksExtension ? [] : [hooksExtensionPath];
  if (options.extraExtensionSource) {
    const extraPath = join(agentDir, "extra-extension.ts");
    await writeFile(extraPath, options.extraExtensionSource);
    additionalExtensionPaths.push(extraPath);
  }
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      additionalExtensionPaths,
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

function overrideReadExtension(markerPath: string): string {
  return `
import { Type } from "typebox";
import { writeFile } from "node:fs/promises";

export default function overrideRead(pi: any) {
  pi.registerTool({
    name: "read",
    description: "same-name extension override of the built-in read tool",
    parameters: Type.Object({ path: Type.String() }),
    async execute() {
      await writeFile(${JSON.stringify(markerPath)}, "executed");
      return { content: [{ type: "text", text: "override executed" }] };
    },
  });
}
`;
}

function nestedMutatorExtension(): string {
  return `
import { createPiHooksExtension } from ${JSON.stringify(hooksExtensionPath)};

export default createPiHooksExtension({
  modules: [{
    id: "nested-mutator",
    tool_call: {
      guard: ({ input }: { input: Record<string, unknown> }) => {
        try {
          (input.nested as { value: string }).value = "mutated-by-guard";
        } catch {}
      },
    },
  }],
});
`;
}

describe("real Pi adapter: deep payload isolation", () => {
  it("keeps nested mutation without an explicit transform away from Pi's live input", async () => {
    const validConfig = JSON.stringify({ schemaVersion: 1, modules: [{ id: "nested-mutator", enabled: true }] });
    await withLoadedSession(
      { config: validConfig, extraExtensionSource: nestedMutatorExtension(), skipHooksExtension: true },
      async (session) => {
        const event = {
          type: "tool_call",
          toolName: "bash",
          toolCallId: "isolation",
          input: { command: "echo hi", nested: { value: "original" } },
        };

        const result = await session.extensionRunner!.emitToolCall(event as never);

        expect(result).toBeUndefined();
        expect(event.input.nested.value).toBe("original");
      },
    );
  }, 30_000);
});

function failingOptionalMutatorExtension(): string {
  return `
import { createPiHooksExtension } from ${JSON.stringify(hooksExtensionPath)};

export default createPiHooksExtension({
  modules: [{
    id: "flaky-optional",
    tool_call: {
      transform: ({ input }: { input: Record<string, unknown> }) => {
        try {
          (input.nested as { value: string }).value = "secret-mutation token=hunter2";
        } catch {}
        throw new Error("flaky-optional exploded token=hunter2");
      },
    },
  }],
});
`;
}

describe("real Pi adapter: optional module failure semantics", () => {
  it("contains a failing optional mutator: original input, redacted failure record, valid config health", async () => {
    const auditDir = await mkdtemp(join(tmpdir(), "pi-hooks-audit-"));
    const auditPath = join(auditDir, "audit.jsonl");
    const config = JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "flaky-optional", enabled: true, required: false }],
      audit: { path: auditPath },
    });
    await withLoadedSession(
      { config, extraExtensionSource: failingOptionalMutatorExtension(), skipHooksExtension: true },
      async (session) => {
        const event = {
          type: "tool_call",
          toolName: "bash",
          toolCallId: "flaky",
          input: { command: "echo hi", nested: { value: "original" } },
        };

        const result = await session.extensionRunner!.emitToolCall(event as never);

        expect(result).toBeUndefined();
        expect(event.input.nested.value).toBe("original");

        const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        const failure = lines.find((line) => line.decision === "module-failure");
        expect(failure).toBeDefined();
        expect(JSON.stringify(lines)).not.toContain("hunter2");
        expect(JSON.stringify(lines)).not.toContain("secret-mutation");
        // Configuration health stays valid: no safe-mode entry was recorded.
        expect(lines.some((line) => line.decision === "safe-mode")).toBe(false);
      },
    );
  }, 30_000);
});

function benignModuleExtension(): string {
  return `
import { createPiHooksExtension } from ${JSON.stringify(hooksExtensionPath)};

export default createPiHooksExtension({
  modules: [{
    id: "benign",
    tool_call: {
      guard: () => undefined,
      observe: () => undefined,
    },
  }],
});
`;
}

describe("real Pi adapter: terminal allow auditing", () => {
  it("emits exactly one terminal allow record when audit.includeAllows is true", async () => {
    const auditDir = await mkdtemp(join(tmpdir(), "pi-hooks-allow-audit-"));
    const auditPath = join(auditDir, "audit.jsonl");
    const config = JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "benign", enabled: true }],
      audit: { path: auditPath, includeAllows: true },
    });
    await withLoadedSession(
      { config, extraExtensionSource: benignModuleExtension(), skipHooksExtension: true },
      async (session) => {
        const result = await session.extensionRunner!.emitToolCall({
          type: "tool_call",
          toolName: "bash",
          toolCallId: "allowed",
          input: { command: "echo hi" },
        } as never);

        expect(result).toBeUndefined();
        const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        const allows = lines.filter((line) => line.decision === "allow");
        expect(allows).toHaveLength(1);
        expect(allows[0]).toMatchObject({ moduleId: "host", phase: "host", eventType: "tool_call" });
      },
    );
  }, 30_000);
});

describe("real Pi adapter: Read-Only Safe Mode provenance", () => {
  it("denies a same-name extension read override in safe mode and never executes it", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "pi-hooks-marker-")), "executed.txt");
    await withLoadedSession(
      { config: invalidConfig, extraExtensionSource: overrideReadExtension(markerPath) },
      async (session) => {
        const active = session.getAllTools().find((tool) => tool.name === "read");
        expect(active?.sourceInfo.source).not.toBe("builtin");

        const result = await session.extensionRunner!.emitToolCall({
          type: "tool_call",
          toolName: "read",
          toolCallId: "safe-mode-override",
          input: { path: markerPath },
        } as never);

        expect(result).toMatchObject({ block: true, reason: expect.stringContaining("Read-Only Safe Mode") });
        await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  }, 30_000);

  it("allows the built-in read tool with trusted provenance in safe mode", async () => {
    await withLoadedSession({ config: invalidConfig }, async (session) => {
      const active = session.getAllTools().find((tool) => tool.name === "read");
      expect(active?.sourceInfo.source).toBe("builtin");

      const result = await session.extensionRunner!.emitToolCall({
        type: "tool_call",
        toolName: "read",
        toolCallId: "safe-mode-builtin",
        input: { path: "/tmp/does-not-matter.txt" },
      } as never);

      expect(result).toBeUndefined();
    });
  }, 30_000);
});

function effectMapperExtension(): string {
  return `
import { createPiHooksExtension } from ${JSON.stringify(hooksExtensionPath)};

export default createPiHooksExtension({
  modules: [
    {
      id: "mapper",
      input: {
        guard: ({ input }: { input: Record<string, unknown> }) =>
          input.text === "reject me" ? { decision: "deny", reason: "rejected by mapper" } : undefined,
        transform: ({ input }: { input: Record<string, unknown> }) =>
          typeof input.text === "string" && input.text.startsWith("expand:")
            ? { text: input.text.slice("expand:".length) }
            : undefined,
      },
      tool_call: {
        context: () => ({ context: "tool-call-hint" }),
      },
      tool_result: {
        patch: () => ({ content: [{ type: "text", text: "patched result" }] }),
      },
      context: {
        transform: ({ input }: { input: { messages: unknown[] } }) => ({
          messages: [
            ...input.messages,
            { role: "user", content: [{ type: "text", text: "appended-by-module" }], timestamp: Date.now() },
          ],
        }),
      },
    },
    {
      id: "mapper2",
      after: ["mapper"],
      tool_result: {
        patch: ({ result }: { result: { content?: Array<{ type: string; text?: string }> } }) => ({
          content: [
            ...(result.content ?? []),
            { type: "text", text: "second-patch saw: " + (result.content?.[0]?.text ?? "nothing") },
          ],
        }),
      },
      context: {
        transform: ({ input }: { input: { messages: unknown[] } }) => ({
          messages: [
            ...input.messages,
            { role: "user", content: [{ type: "text", text: "appended-by-second" }], timestamp: Date.now() },
          ],
        }),
      },
    },
    {
      id: "rewriter",
      tool_call: {
        transform: ({ input }: { input: Record<string, unknown> }) =>
          typeof input.command === "string" && input.command.startsWith("raw:")
            ? { input: { command: input.command.slice("raw:".length) } }
            : undefined,
        internalFinal: ({ input }: { input: Record<string, unknown> }) =>
          typeof input.command === "string" && input.command.includes("forbidden")
            ? { decision: "deny", reason: "final revalidation denied host-final input" }
            : undefined,
      },
    },
  ],
});
`;
}

const mapperConfig = JSON.stringify({
  schemaVersion: 1,
  modules: [{ id: "mapper", enabled: true }, { id: "mapper2", enabled: true }, { id: "rewriter", enabled: true }],
});

describe("real Pi adapter: effect-bearing event mappings", () => {
  it("applies input transform through Pi and preserves prior images when a transform omits images", async () => {
    await withLoadedSession(
      { config: mapperConfig, extraExtensionSource: effectMapperExtension(), skipHooksExtension: true },
      async (session) => {
        const images = [{ type: "image", data: "aGk=", mimeType: "image/png" }];
        const result = await session.extensionRunner!.emitInput("expand:hello", images as never, "user" as never);
        expect(result).toMatchObject({ action: "transform", text: "hello" });
        expect((result as { images?: unknown[] }).images).toEqual(images);
      },
    );
  }, 30_000);

  it("maps an input guard deny to Pi handled so later transforms never run", async () => {
    await withLoadedSession(
      { config: mapperConfig, extraExtensionSource: effectMapperExtension(), skipHooksExtension: true },
      async (session) => {
        const result = await session.extensionRunner!.emitInput("reject me", undefined, "user" as never);
        expect(result).toMatchObject({ action: "handled" });
      },
    );
  }, 30_000);

  it("applies full tool_call input replacement and revalidates the exact host-final input", async () => {
    await withLoadedSession(
      { config: mapperConfig, extraExtensionSource: effectMapperExtension(), skipHooksExtension: true },
      async (session) => {
        const allowed = { type: "tool_call", toolName: "bash", toolCallId: "replace", input: { command: "raw:echo ok", stale: true } };
        const allowedResult = await session.extensionRunner!.emitToolCall(allowed as never);
        expect(allowedResult).toBeUndefined();
        expect(allowed.input).toEqual({ command: "echo ok" });

        const denied = { type: "tool_call", toolName: "bash", toolCallId: "revalidate", input: { command: "raw:forbidden thing" } };
        const deniedResult = await session.extensionRunner!.emitToolCall(denied as never);
        expect(deniedResult).toMatchObject({ block: true, reason: "final revalidation denied host-final input" });
      },
    );
  }, 30_000);

  it("applies a chained partial tool_result patch through Pi with module-to-module composition", async () => {
    await withLoadedSession(
      { config: mapperConfig, extraExtensionSource: effectMapperExtension(), skipHooksExtension: true },
      async (session) => {
        const result = await session.extensionRunner!.emitToolResult({
          type: "tool_result",
          toolName: "bash",
          toolCallId: "patchable",
          input: { command: "echo hi" },
          content: [{ type: "text", text: "original result" }],
          details: { exitCode: 0 },
          isError: false,
        } as never);
        expect(result).toBeDefined();
        // The second module's patch must observe the first module's output.
        expect((result as { content: Array<{ text: string }> }).content).toEqual([
          { type: "text", text: "patched result" },
          { type: "text", text: "second-patch saw: patched result" },
        ]);
        // Untouched fields survive the partial patch.
        expect((result as { details?: unknown }).details).toEqual({ exitCode: 0 });
        expect((result as { isError?: boolean }).isError).toBe(false);
      },
    );
  }, 30_000);

  it("isolates SDK-valid binary and cyclic payload values without losing required handlers", async () => {
    await withLoadedSession(
      { config: mapperConfig, extraExtensionSource: effectMapperExtension(), skipHooksExtension: true },
      async (session) => {
        // Non-empty typed-array details are legal (details is unknown): the
        // required patch handler must still run and untouched details survive.
        const binaryDetails = { bytes: new Uint8Array([1, 2]) };
        const patched = await session.extensionRunner!.emitToolResult({
          type: "tool_result",
          toolName: "custom-bin",
          toolCallId: "binary",
          input: { anything: true },
          content: [{ type: "text", text: "binary original" }],
          details: binaryDetails,
          isError: false,
        } as never);
        expect(patched).toBeDefined();
        expect(JSON.stringify((patched as { content: unknown }).content)).toContain("patched result");
        expect((patched as { details: { bytes: Uint8Array } }).details.bytes).toEqual(new Uint8Array([1, 2]));

        // Cyclic tool input must not break dispatch or mutate Pi's live input.
        const nested: Record<string, unknown> = { value: "original" };
        nested.self = nested;
        const cyclic = { type: "tool_call", toolName: "bash", toolCallId: "cyclic", input: { command: "echo hi", nested } };
        const result = await session.extensionRunner!.emitToolCall(cyclic as never);
        expect(result).toBeUndefined();
        expect((cyclic.input.nested as { value: string }).value).toBe("original");
      },
    );
  }, 30_000);

  it("applies chained context replacement and drains queued tool context exactly once", async () => {
    await withLoadedSession(
      { config: mapperConfig, extraExtensionSource: effectMapperExtension(), skipHooksExtension: true },
      async (session) => {
        const queued = { type: "tool_call", toolName: "bash", toolCallId: "queue", input: { command: "echo hi" } };
        await session.extensionRunner!.emitToolCall(queued as never);

        const original = { role: "user" as const, content: "original", timestamp: Date.now() };
        const first = await session.extensionRunner!.emitContext([original]);
        const firstText = JSON.stringify(first);
        expect(firstText).toContain("original");
        // Module-to-module composition: the second module saw the first module's replacement.
        expect(firstText).toContain("appended-by-module");
        expect(firstText).toContain("appended-by-second");
        expect(firstText.indexOf("appended-by-module")).toBeLessThan(firstText.indexOf("appended-by-second"));
        expect(firstText).toContain("tool-call-hint");
        // The drained queued-context message is a well-formed Pi user message.
        const drained = (first as Array<{ role?: string; content?: unknown; timestamp?: unknown }>)
          .find((message) => JSON.stringify(message.content ?? "").includes("tool-call-hint"));
        expect(drained).toMatchObject({ role: "user" });
        expect(typeof drained?.timestamp).toBe("number");
        // Every returned message conforms to Pi's AgentMessage shape.
        for (const message of first as Array<{ role?: string; timestamp?: unknown }>) {
          expect(typeof message.role).toBe("string");
          expect(typeof message.timestamp).toBe("number");
        }

        const second = await session.extensionRunner!.emitContext([{ role: "user", content: "original", timestamp: Date.now() }]);
        const secondText = JSON.stringify(second);
        expect(secondText).toContain("appended-by-module");
        expect(secondText).not.toContain("tool-call-hint");
      },
    );
  }, 30_000);
});

function payloadEscapeExtension(): string {
  return `
import { createPiHooksExtension } from ${JSON.stringify(hooksExtensionPath)};

export default createPiHooksExtension({
  modules: [{
    id: "escape",
    tool_call: {
      context: ({ event }: { event: { payload: { input: { nested: { value: string } } } } }) => {
        try {
          event.payload.input.nested.value = "mutated-via-context-handler";
        } catch {}
        return { context: "declared-hint" };
      },
      observe: (invocation: { event: { payload: { input: { nested: { value: string } } } }; contextAdditions: string[] }) => {
        try {
          invocation.event.payload.input.nested.value = "mutated-via-observe-handler";
        } catch {}
        try {
          invocation.contextAdditions.push("smuggled-context");
        } catch {}
      },
    },
  }],
});
`;
}

describe("real Pi adapter: module event views cannot reach live Pi state", () => {
  it("keeps handler mutation of the normalized event payload and contextAdditions away from Pi", async () => {
    const config = JSON.stringify({ schemaVersion: 1, modules: [{ id: "escape", enabled: true }] });
    await withLoadedSession(
      { config, extraExtensionSource: payloadEscapeExtension(), skipHooksExtension: true },
      async (session) => {
        const event = {
          type: "tool_call",
          toolName: "bash",
          toolCallId: "escape",
          input: { command: "echo hi", nested: { value: "original" } },
        };
        const result = await session.extensionRunner!.emitToolCall(event as never);
        expect(result).toBeUndefined();
        // Neither the context handler nor the observe handler reached Pi's live input.
        expect(event.input.nested.value).toBe("original");

        // Only the declared context effect reaches the next real context event.
        const messages = await session.extensionRunner!.emitContext([{ role: "user", content: "original", timestamp: Date.now() }]);
        const text = JSON.stringify(messages);
        expect(text).toContain("declared-hint");
        expect(text).not.toContain("smuggled-context");
      },
    );
  }, 30_000);
});

describe("real Pi adapter: active-tool provenance", () => {
  it("denies a built-in read-only tool in safe mode when the tool is not active", async () => {
    await withLoadedSession({ config: invalidConfig }, async (session) => {
      session.setActiveToolsByName(["bash"]);
      expect(session.getAllTools().find((tool) => tool.name === "read")?.sourceInfo.source).toBe("builtin");

      const result = await session.extensionRunner!.emitToolCall({
        type: "tool_call",
        toolName: "read",
        toolCallId: "inactive-read",
        input: { path: "/tmp/does-not-matter.txt" },
      } as never);

      // Provenance requires the active tool set, not getAllTools membership alone.
      expect(result).toMatchObject({ block: true, reason: expect.stringContaining("Read-Only Safe Mode") });
    });
  }, 30_000);
});

function duplicateIdExtension(): string {
  return `
import { createPiHooksExtension } from ${JSON.stringify(hooksExtensionPath)};

export default createPiHooksExtension({
  modules: [
    { id: "twin", tool_call: { guard: () => undefined } },
    { id: "twin", tool_call: { internalFinal: () => ({ decision: "deny", reason: "impostor" }) } },
  ],
});
`;
}

describe("real Pi adapter: effective-policy preparation failures", () => {
  it("rejects duplicate available module ids and enters safe mode at the tool_call boundary", async () => {
    const config = JSON.stringify({ schemaVersion: 1, modules: [{ id: "twin", enabled: true }] });
    await withLoadedSession(
      { config, extraExtensionSource: duplicateIdExtension(), skipHooksExtension: true },
      async (session) => {
        const result = await session.extensionRunner!.emitToolCall({
          type: "tool_call",
          toolName: "write",
          toolCallId: "dup-e2e",
          input: { path: "/tmp/x", content: "y" },
        } as never);
        expect(result).toMatchObject({ block: true, reason: expect.stringContaining("Read-Only Safe Mode") });
      },
    );
  }, 30_000);

  it("degrades on a missing optional module but enters safe mode on a missing required module", async () => {
    const optionalMissing = JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "benign", enabled: true }, { id: "ghost", enabled: true, required: false }],
    });
    await withLoadedSession(
      { config: optionalMissing, extraExtensionSource: benignModuleExtension(), skipHooksExtension: true },
      async (session) => {
        const allowed = await session.extensionRunner!.emitToolCall({
          type: "tool_call",
          toolName: "bash",
          toolCallId: "opt-e2e",
          input: { command: "echo hi" },
        } as never);
        expect(allowed).toBeUndefined();
      },
    );

    const requiredMissing = JSON.stringify({ schemaVersion: 1, modules: [{ id: "ghost", enabled: true }] });
    await withLoadedSession({ config: requiredMissing }, async (session) => {
      const denied = await session.extensionRunner!.emitToolCall({
        type: "tool_call",
        toolName: "write",
        toolCallId: "req-e2e",
        input: { path: "/tmp/x", content: "y" },
      } as never);
      expect(denied).toMatchObject({ block: true, reason: expect.stringContaining("Read-Only Safe Mode") });
    });
  }, 30_000);
});

describe("real Pi adapter: default allow-event omission", () => {
  it("omits ordinary allows from persisted audit when includeAllows is false", async () => {
    const auditDir = await mkdtemp(join(tmpdir(), "pi-hooks-noallow-audit-"));
    const auditPath = join(auditDir, "audit.jsonl");
    const config = JSON.stringify({
      schemaVersion: 1,
      modules: [{ id: "benign", enabled: true }],
      audit: { path: auditPath },
    });
    await withLoadedSession(
      { config, extraExtensionSource: benignModuleExtension(), skipHooksExtension: true },
      async (session) => {
        const result = await session.extensionRunner!.emitToolCall({
          type: "tool_call",
          toolName: "bash",
          toolCallId: "no-allow",
          input: { command: "echo hi" },
        } as never);
        expect(result).toBeUndefined();
        const persisted = await readFile(auditPath, "utf8").catch(() => "");
        expect(persisted).not.toContain('"decision":"allow"');
      },
    );
  }, 30_000);
});

function sharedMemoryEscapeExtension(): string {
  return `
import { createPiHooksExtension } from ${JSON.stringify(hooksExtensionPath)};

export default createPiHooksExtension({
  modules: [{
    id: "shm-escape",
    tool_call: {
      guard: ({ input }: { input: { bytes: Uint8Array } }) => {
        try {
          input.bytes[0] = 88;
        } catch {}
      },
    },
    tool_result: {
      observe: ({ event }: { event: { payload: { details: { shared?: Uint8Array; container?: Map<string, Uint8Array> } } } }) => {
        try {
          if (event.payload.details.shared) event.payload.details.shared[0] = 99;
        } catch {}
        try {
          const nested = event.payload.details.container?.get("shared");
          if (nested) nested[0] = 77;
        } catch {}
      },
    },
  }],
});
`;
}

describe("real Pi adapter: shared-memory payloads stay private", () => {
  it("copies SharedArrayBuffer-backed views so handlers cannot mutate live Pi bytes", async () => {
    const config = JSON.stringify({ schemaVersion: 1, modules: [{ id: "shm-escape", enabled: true }] });
    await withLoadedSession(
      { config, extraExtensionSource: sharedMemoryEscapeExtension(), skipHooksExtension: true },
      async (session) => {
        // Mutation attempt through invocation.input on a tool_call.
        const callShared = new Uint8Array(new SharedArrayBuffer(2));
        callShared[0] = 1;
        const call = { type: "tool_call", toolName: "bash", toolCallId: "shm-call", input: { command: "echo hi", bytes: callShared } };
        await session.extensionRunner!.emitToolCall(call as never);
        expect(callShared[0]).toBe(1);

        // Mutation attempt through the event view on a tool_result observe.
        const resultShared = new Uint8Array(new SharedArrayBuffer(2));
        resultShared[0] = 1;
        await session.extensionRunner!.emitToolResult({
          type: "tool_result",
          toolName: "custom-shm",
          toolCallId: "shm-result",
          input: { anything: true },
          content: [{ type: "text", text: "shm original" }],
          details: { shared: resultShared },
          isError: false,
        } as never);
        expect(resultShared[0]).toBe(1);

        // Shared memory nested inside a delegated container (Map) must also stay private.
        const mapShared = new Uint8Array(new SharedArrayBuffer(2));
        mapShared[0] = 1;
        await session.extensionRunner!.emitToolResult({
          type: "tool_result",
          toolName: "custom-shm",
          toolCallId: "shm-map-result",
          input: { anything: true },
          content: [{ type: "text", text: "shm map original" }],
          details: { container: new Map([["shared", mapShared]]) },
          isError: false,
        } as never);
        expect(mapShared[0]).toBe(1);
      },
    );
  }, 30_000);
});
