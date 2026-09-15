import { describe, expect, it } from "vitest";
import type { CapabilityProvider, GrantFacade, HookModule } from "../src/index.js";

/**
 * Compile-time contract (SLICE-0007/SLICE-0008): HookModule effects are
 * event-keyed. The four effect-bearing events expose exactly the effects Pi
 * 0.85.1 consumes; the five observe-only events expose observe only. These
 * assertions run under `npm run verify` typecheck (tsconfig includes test/).
 */

const effectBearing: HookModule = {
  id: "effect-bearing",
  input: {
    guard: () => ({ decision: "deny", reason: "input guard maps to Pi handled" }),
    transform: () => ({ text: "replacement text" }),
    observe: () => undefined,
  },
  tool_call: {
    guard: () => ({ decision: "deny" }),
    transform: () => ({ input: { command: "full replacement" } }),
    internalFinal: () => ({ decision: "deny" }),
    context: () => ({ context: "queued for the next real context event" }),
    observe: () => undefined,
  },
  tool_result: {
    patch: () => ({ content: [{ type: "text", text: "partial patch" }] }),
    context: () => ({ context: "queued" }),
    observe: () => undefined,
  },
  context: {
    transform: () => ({ messages: [{ role: "user", content: "hidden", timestamp: Date.now() }] }),
    observe: () => undefined,
  },
};

const observeOnly: HookModule = {
  id: "observe-only",
  agent_end: { observe: () => undefined },
  session_start: { observe: () => undefined },
  session_shutdown: { observe: () => undefined },
  session_before_compact: { observe: () => undefined },
  session_compact: { observe: () => undefined },
};

const agentEndRejectsEffects: HookModule = {
  id: "agent-end-observe-only",
  // @ts-expect-error agent_end is observe-only: transform is unexpressible
  agent_end: { transform: () => ({ input: {} }) },
};

const sessionStartRejectsEffects: HookModule = {
  id: "session-start-observe-only",
  // @ts-expect-error session_start is observe-only: guard is unexpressible
  session_start: { guard: () => ({ decision: "deny" as const }) },
};

const sessionShutdownRejectsEffects: HookModule = {
  id: "session-shutdown-observe-only",
  // @ts-expect-error session_shutdown is observe-only: context is unexpressible
  session_shutdown: { context: () => ({ context: "hidden" }) },
};

const sessionBeforeCompactRejectsEffects: HookModule = {
  id: "session-before-compact-observe-only",
  // @ts-expect-error session_before_compact is observe-only in this slice: transform is unexpressible
  session_before_compact: { transform: () => ({ messages: [] }) },
};

const sessionCompactRejectsEffects: HookModule = {
  id: "session-compact-observe-only",
  // @ts-expect-error session_compact is observe-only: patch is unexpressible
  session_compact: { patch: () => ({ content: [] }) },
};

const inputRejectsForeignEffects: HookModule = {
  id: "input-no-tool-effects",
  // @ts-expect-error input has no internalFinal or patch effect
  input: { internalFinal: () => ({ decision: "deny" as const }) },
};

const contextRejectsForeignEffects: HookModule = {
  id: "context-no-guard",
  // @ts-expect-error context has no guard effect
  context: { guard: () => ({ decision: "deny" as const }) },
};

const inputRejectsMalformedImages: HookModule = {
  id: "input-exact-images",
  // @ts-expect-error images must be Pi ImageContent values, not arbitrary objects
  input: { transform: () => ({ text: "x", images: [{ nope: true }] }) },
};

const toolResultRejectsMalformedContent: HookModule = {
  id: "tool-result-exact-content",
  // @ts-expect-error content must be Pi (TextContent | ImageContent)[], not a string
  tool_result: { patch: () => ({ content: "not-an-array" }) },
};

const contextRejectsMalformedMessages: HookModule = {
  id: "context-exact-messages",
  // @ts-expect-error messages must be Pi AgentMessage values (role/content/timestamp), not bare objects
  context: { transform: () => ({ messages: [{ role: "user" }] }) },
};

/**
 * Capability grant facade contract (SLICE-0009): a provider receives only the
 * grant kinds it declares. Model-provider registration and raw ExtensionAPI
 * passthrough are not grant kinds and are unexpressible by type.
 */
function grantFacadeAssertions(): void {
  const toolsFacade = {} as GrantFacade<"tools">;
  toolsFacade.tools.registerTool({} as never); // declared grant is usable
  // @ts-expect-error the events grant is undeclared for a tools-only facade
  void toolsFacade.events;

  const eventsFacade = {} as GrantFacade<"events">;
  eventsFacade.events.registerModule({ id: "m" });
  // @ts-expect-error raw Pi ExtensionAPI (pi.on) is never handed to a provider
  void eventsFacade.on;
  // @ts-expect-error model-provider registration is not a grant and is unexpressible
  void eventsFacade.registerProvider;

  // @ts-expect-error "registerProvider" is not a GrantKind, so no such facade exists
  const _noProviderGrant = {} as GrantFacade<"registerProvider">;
  void _noProviderGrant;

  // A directly annotated (non-defineProvider) events-only provider still cannot
  // reach an undeclared grant: CapabilityProvider has no all-grants default.
  const eventsOnlyProvider: CapabilityProvider<"events"> = {
    manifest: { id: "p", version: "1.0.0", grants: ["events"] },
    activate(facade) {
      facade.events.registerModule({ id: "m" });
      // @ts-expect-error events-only provider cannot use the tools grant
      void facade.tools;
    },
  };
  void eventsOnlyProvider;
}

describe("capability grant facade contract", () => {
  it("exposes only declared grants and never model-provider or raw ExtensionAPI", () => {
    expect(typeof grantFacadeAssertions).toBe("function");
  });
});

describe("event-keyed HookModule contract", () => {
  it("accepts exactly the per-event effects Pi 0.85.1 consumes", () => {
    const modules = [
      effectBearing,
      observeOnly,
      agentEndRejectsEffects,
      sessionStartRejectsEffects,
      sessionShutdownRejectsEffects,
      sessionBeforeCompactRejectsEffects,
      sessionCompactRejectsEffects,
      inputRejectsForeignEffects,
      contextRejectsForeignEffects,
      inputRejectsMalformedImages,
      toolResultRejectsMalformedContent,
      contextRejectsMalformedMessages,
    ];
    expect(modules.map((module) => module.id)).toHaveLength(12);
  });
});
