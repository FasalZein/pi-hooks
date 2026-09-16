import { createPiHooksExtension } from "./adapter.js";

export { createPiHooksExtension } from "./adapter.js";
export { normalizeEvent } from "./events.js";
export { createHookHost } from "./host.js";
export type { CreateHookHostOptions, HookHost, PiGrantBindings } from "./host.js";
export { defineProvider, GRANT_KINDS } from "./grants.js";
export { policyEngineProvider, PolicyEngineConfigSchema } from "./policy-engine.js";
export type { PolicyEngineConfig, PolicyRuleConfig } from "./policy-engine.js";
export type {
  CapabilityManifest,
  CapabilityProvider,
  ConfirmOutcome,
  ConfirmRequest,
  GrantFacade,
  GrantKind,
  InteractionGrant,
} from "./grants.js";
export type {
  AuditRecord,
  ContextDispatchResult,
  ContextHandlers,
  DispatchContext,
  DispatchResult,
  GuardResult,
  HookDecision,
  HookEventType,
  HookInvocation,
  HookModule,
  HookPhase,
  HostStatus,
  InputDispatchResult,
  InputHandlers,
  NormalizedEvent,
  ObserveInvocation,
  ObserveOnlyEventType,
  ObserveOnlyHandlers,
  ToolCallDispatchResult,
  ToolCallHandlers,
  ToolResultDispatchResult,
  ToolResultHandlers,
  ToolResultPatch,
} from "./types.js";

/** Bare Host: policy is selected only by an explicit composition. */
export default createPiHooksExtension();
