export const PHASES = ["guard", "transform", "internal-final", "context", "observe"] as const;
export type HookPhase = (typeof PHASES)[number];
export type HookDecision = "allow" | "deny";

export interface ToolProvenance {
  source: string;
  path?: string;
}

export interface NormalizedEvent {
  type:
    | "input"
    | "tool_call"
    | "tool_result"
    | "agent_end"
    | "session_start"
    | "session_shutdown"
    | "session_before_compact"
    | "session_compact";
  sourceType: string;
  toolName?: string;
  toolCallId?: string;
  input: Record<string, unknown>;
  isError?: boolean;
  provenance?: ToolProvenance;
  payload: Record<string, unknown>;
}

export interface DispatchContext {
  cwd: string;
  hasUI: boolean;
  sessionManager?: {
    getSessionFile?(): string | undefined;
    getSessionId?(): string;
  };
}

export interface HookInvocation {
  event: NormalizedEvent;
  input: Readonly<Record<string, unknown>>;
  context: DispatchContext;
}

export interface ObserveInvocation extends HookInvocation {
  decision: HookDecision;
  reason?: string;
  contextAdditions: readonly string[];
}

export interface HookModule {
  id: string;
  requires?: readonly string[];
  before?: readonly string[];
  after?: readonly string[];
  guard?(invocation: HookInvocation): void | { decision: HookDecision; reason?: string } | Promise<void | { decision: HookDecision; reason?: string }>;
  transform?(invocation: HookInvocation): void | { input: Record<string, unknown> } | Promise<void | { input: Record<string, unknown> }>;
  internalFinal?(invocation: HookInvocation): void | { decision: HookDecision; reason?: string } | Promise<void | { decision: HookDecision; reason?: string }>;
  context?(invocation: HookInvocation): void | { context: string | readonly string[] } | Promise<void | { context: string | readonly string[] }>;
  observe?(invocation: ObserveInvocation): void | Promise<void>;
}

export interface AuditRecord {
  timestamp: string;
  sessionId?: string;
  moduleId: string;
  eventType: NormalizedEvent["type"];
  phase: HookPhase | "host";
  decision: "allow" | "deny" | "mutate" | "module-failure" | "safe-mode";
  reason?: string;
  inputSummary?: unknown;
}

export interface DispatchResult {
  decision: HookDecision;
  reason?: string;
  /** True only when a module transform produced an explicit replacement input. */
  mutated: boolean;
  input: Record<string, unknown>;
  contextAdditions: string[];
}

export interface HostStatus {
  configSource: string;
  /** Configuration validity lane: preparation and schema failures only. */
  configuration: {
    health: "valid" | "invalid";
    lastFailure?: string;
  };
  /** Runtime module health lane: module execution failures only. */
  runtime: {
    health: "healthy" | "degraded";
    lastFailure?: string;
  };
  modules: Array<{ id: string; enabled: boolean; required: boolean }>;
  phaseOrder: Record<HookPhase, string[]>;
  mode: "normal" | "read-only-safe";
  /** Audit persistence health lane: append/serialization failures only. */
  audit: {
    health: "healthy" | "degraded";
    lastFailure?: string;
    retained: number;
  };
  finalInterceptor: {
    available: false;
    boundary: string;
  };
}
