import type { ContextEvent, InputEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";

/** Pi's exact payload types, derived from the public SDK surface. */
export type PiInputImages = NonNullable<Extract<InputEventResult, { action: "transform" }>["images"]>;
export type PiToolResultContent = ToolResultEvent["content"];
export type PiContextMessages = ContextEvent["messages"];

export const PHASES = ["guard", "transform", "internal-final", "context", "observe"] as const;
export type HookPhase = (typeof PHASES)[number];
export type HookDecision = "allow" | "deny";

export const EVENT_TYPES = [
  "input",
  "tool_call",
  "tool_result",
  "context",
  "agent_end",
  "session_start",
  "session_shutdown",
  "session_before_compact",
  "session_compact",
] as const;
export type HookEventType = (typeof EVENT_TYPES)[number];
export type ObserveOnlyEventType = "agent_end" | "session_start" | "session_shutdown" | "session_before_compact" | "session_compact";

export interface ToolProvenance {
  source: string;
  path?: string;
}

export interface NormalizedEvent {
  type: HookEventType;
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
  /** Real Pi UI surface, present on events dispatched from a loaded session. */
  ui?: {
    setStatus(key: string, text: string | undefined): void;
    setWidget?(key: string, lines: readonly string[] | undefined): void;
  };
}

export interface HookInvocation {
  event: NormalizedEvent;
  input: Readonly<Record<string, unknown>>;
  context: DispatchContext;
  /** Present only on tool_result: the current (chained) result view a patch applies to. */
  result?: Readonly<ToolResultPatch>;
}

export interface ObserveInvocation extends HookInvocation {
  decision: HookDecision;
  reason?: string;
  contextAdditions: readonly string[];
}

type MaybePromise<T> = T | Promise<T>;

export interface GuardResult {
  decision: HookDecision;
  reason?: string;
}

/** Pi input transform: full text replacement; omitted images preserve Pi's prior images. */
export interface InputTransformResult {
  text: string;
  images?: PiInputImages;
}

/** Pi tool_call transform: a full input replacement, never a patch. */
export interface ToolCallTransformResult {
  input: Record<string, unknown>;
}

/** Pi tool_result effect: a partial patch of content/details/isError. */
export interface ToolResultPatch {
  content?: PiToolResultContent;
  details?: unknown;
  isError?: boolean;
}

/** Pi context effect: full message-list replacement. */
export interface ContextTransformResult {
  messages: PiContextMessages;
}

export interface ContextAdditionResult {
  context: string | readonly string[];
}

export interface InputHandlers {
  guard?(invocation: HookInvocation): MaybePromise<void | GuardResult>;
  transform?(invocation: HookInvocation): MaybePromise<void | InputTransformResult>;
  observe?(invocation: ObserveInvocation): MaybePromise<void>;
}

export interface ToolCallHandlers {
  guard?(invocation: HookInvocation): MaybePromise<void | GuardResult>;
  transform?(invocation: HookInvocation): MaybePromise<void | ToolCallTransformResult>;
  internalFinal?(invocation: HookInvocation): MaybePromise<void | GuardResult>;
  context?(invocation: HookInvocation): MaybePromise<void | ContextAdditionResult>;
  observe?(invocation: ObserveInvocation): MaybePromise<void>;
}

export interface ToolResultHandlers {
  patch?(invocation: HookInvocation): MaybePromise<void | ToolResultPatch>;
  context?(invocation: HookInvocation): MaybePromise<void | ContextAdditionResult>;
  observe?(invocation: ObserveInvocation): MaybePromise<void>;
}

export interface ContextHandlers {
  transform?(invocation: HookInvocation): MaybePromise<void | ContextTransformResult>;
  observe?(invocation: ObserveInvocation): MaybePromise<void>;
}

export interface ObserveOnlyHandlers {
  observe?(invocation: ObserveInvocation): MaybePromise<void>;
}

/**
 * Event-keyed Hook Module contract (SLICE-0007/SLICE-0008): each exposed event
 * offers exactly the effects the real Pi 0.80.7 adapter consumes for it, so an
 * unsupported effect is unexpressible by type rather than silently discarded.
 */
export interface HookModule {
  id: string;
  requires?: readonly string[];
  before?: readonly string[];
  after?: readonly string[];
  input?: InputHandlers;
  tool_call?: ToolCallHandlers;
  tool_result?: ToolResultHandlers;
  context?: ContextHandlers;
  agent_end?: ObserveOnlyHandlers;
  session_start?: ObserveOnlyHandlers;
  session_shutdown?: ObserveOnlyHandlers;
  session_before_compact?: ObserveOnlyHandlers;
  session_compact?: ObserveOnlyHandlers;
}

export interface AuditRecord {
  timestamp: string;
  sessionId?: string;
  moduleId: string;
  /** Provider/engine attribution: which capability produced this record. */
  provider?: string;
  eventType: NormalizedEvent["type"];
  phase: HookPhase | "host";
  decision: "allow" | "deny" | "mutate" | "module-failure" | "safe-mode" | "grant-refused";
  reason?: string;
  inputSummary?: unknown;
}

interface DispatchBase {
  decision: HookDecision;
  reason?: string;
}

export interface InputDispatchResult extends DispatchBase {
  event: "input";
  /** True only when a module transform produced an explicit replacement. */
  mutated: boolean;
  text?: string;
  /** Omitted unless a module supplied replacement images; Pi preserves prior images. */
  images?: PiInputImages;
}

export interface ToolCallDispatchResult extends DispatchBase {
  event: "tool_call";
  /** True only when a module transform produced an explicit full replacement input. */
  mutated: boolean;
  input: Record<string, unknown>;
  contextAdditions: readonly string[];
}

export interface ToolResultDispatchResult extends DispatchBase {
  event: "tool_result";
  /** Merged partial patch, present only when a module produced one. */
  patch?: ToolResultPatch;
  contextAdditions: readonly string[];
}

export interface ContextDispatchResult extends DispatchBase {
  event: "context";
  /** Replacement message list, present only when a module transform produced one. */
  messages?: PiContextMessages;
  /** Queued tool context drained exactly once into this real context event. */
  queuedContext: readonly string[];
}

export interface ObserveOnlyDispatchResult extends DispatchBase {
  event: ObserveOnlyEventType;
}

export type DispatchResult =
  | InputDispatchResult
  | ToolCallDispatchResult
  | ToolResultDispatchResult
  | ContextDispatchResult
  | ObserveOnlyDispatchResult;

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
