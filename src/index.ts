import { createPiHooksExtension } from "./adapter.js";

export { createPiHooksExtension } from "./adapter.js";
export { normalizeEvent } from "./events.js";
export { createHookHost } from "./host.js";
export type { CreateHookHostOptions, HookHost } from "./host.js";
export type {
  AuditRecord,
  DispatchContext,
  DispatchResult,
  HookDecision,
  HookInvocation,
  HookModule,
  HookPhase,
  HostStatus,
  NormalizedEvent,
  ObserveInvocation,
} from "./types.js";

export default createPiHooksExtension();
