import { homedir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit.js";
import { cloneDeep, frozenView } from "./isolate.js";
import { loadGlobalConfig, type GlobalConfig } from "./config.js";
import { preparePolicy } from "./policy.js";
import type {
  AuditRecord,
  ContextDispatchResult,
  DispatchContext,
  DispatchResult,
  HookDecision,
  HookInvocation,
  HookModule,
  HookPhase,
  HostStatus,
  InputDispatchResult,
  NormalizedEvent,
  ObserveOnlyEventType,
  ToolCallDispatchResult,
  ToolResultDispatchResult,
  ToolResultPatch,
} from "./types.js";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EFFECT_BEARING = new Set<NormalizedEvent["type"]>(["input", "tool_call", "tool_result", "context"]);
const FINAL_BOUNDARY = "Authoritative only inside this Host tool_call handler; a later Pi extension can still mutate input before execution.";

export interface CreateHookHostOptions {
  configPath?: string;
  modules?: readonly HookModule[];
}

export interface HookHost {
  dispatch(event: NormalizedEvent, context: DispatchContext): Promise<DispatchResult>;
  status(): HostStatus;
}

export async function createHookHost(options: CreateHookHostOptions = {}): Promise<HookHost> {
  const configPath = options.configPath ?? defaultConfigPath();
  const available = [...(options.modules ?? [])];
  let config: GlobalConfig | undefined;
  let modules: HookModule[] = [];
  let phaseOrder = emptyPhaseOrder();
  let required = new Map<string, boolean>();
  let failure: string | undefined;

  try {
    config = await loadGlobalConfig(configPath);
  } catch (error) {
    failure = message(error);
  }
  if (config) {
    const policy = preparePolicy(available, config);
    if (policy.ok) ({ modules, phaseOrder, required } = policy);
    else failure = policy.failure;
  }

  const audit = new AuditLog(config?.audit?.path, config?.audit?.includeAllows);
  const host = new Host(configPath, config, modules, phaseOrder, required, audit, failure);
  if (failure) await host.recordSafeMode(failure);
  return host;
}

interface PhaseState {
  decision: HookDecision;
  reason?: string;
}

class Host implements HookHost {
  private runtimeFailure?: string;
  private readonly configFailure?: string;
  /** Queued module context effects, drained exactly once on the next real context event. */
  private readonly queuedContext: string[] = [];

  constructor(
    private readonly configPath: string,
    private readonly config: GlobalConfig | undefined,
    private readonly modules: HookModule[],
    private readonly phaseOrder: Record<HookPhase, string[]>,
    private readonly requiredById: Map<string, boolean>,
    private readonly audit: AuditLog,
    failure: string | undefined,
  ) {
    this.configFailure = failure;
  }

  async recordSafeMode(reason: string): Promise<void> {
    await this.audit.record({
      timestamp: new Date().toISOString(),
      moduleId: "host",
      eventType: "session_start",
      phase: "host",
      decision: "safe-mode",
      reason,
    });
  }

  status(): HostStatus {
    const configured = this.config?.modules ?? [];
    const enabledIds = new Set(this.modules.map((module) => module.id));
    const audit = this.audit.status();
    return {
      configSource: this.configPath,
      configuration: {
        health: this.config !== undefined && this.configFailure === undefined ? "valid" : "invalid",
        ...(this.configFailure ? { lastFailure: this.configFailure } : {}),
      },
      runtime: {
        health: this.runtimeFailure ? "degraded" : "healthy",
        ...(this.runtimeFailure ? { lastFailure: this.runtimeFailure } : {}),
      },
      modules: configured.map((entry) => ({
        id: entry.id,
        enabled: enabledIds.has(entry.id),
        required: entry.required !== false,
      })),
      phaseOrder: this.phaseOrder,
      mode: this.isSafeMode() ? "read-only-safe" : "normal",
      audit,
      finalInterceptor: { available: false, boundary: FINAL_BOUNDARY },
    };
  }

  async dispatch(event: NormalizedEvent, context: DispatchContext): Promise<DispatchResult> {
    if (this.isSafeMode()) return this.safeModeDispatch(event, context);
    switch (event.type) {
      case "input":
        return this.dispatchInput(event, context);
      case "tool_call":
        return this.dispatchToolCall(event, context);
      case "tool_result":
        return this.dispatchToolResult(event, context);
      case "context":
        return this.dispatchContext(event, context);
      default:
        return this.dispatchObserveOnly(event, context);
    }
  }

  private async dispatchInput(event: NormalizedEvent, context: DispatchContext): Promise<InputDispatchResult> {
    const input = cloneDeep(event.input);
    const state: PhaseState = { decision: "allow" };
    let mutated = false;
    let images: unknown[] | undefined;

    await this.runPhase(
      "guard", event, context, state, input,
      (module) => module.input?.guard?.bind(module.input),
      async (moduleId, result) => {
        if (result.decision !== "deny") return;
        state.decision = "deny";
        state.reason = result.reason ?? `Denied by ${moduleId}`;
        await this.writeDecision(moduleId, event, context, "guard", "deny", state.reason, input);
      },
    );
    await this.runPhase(
      "transform", event, context, state, input,
      (module) => module.input?.transform?.bind(module.input),
      async (moduleId, result) => {
        input.text = result.text;
        if (result.images !== undefined) {
          images = cloneDeep(result.images);
          input.images = images;
        }
        mutated = true;
        await this.writeDecision(moduleId, event, context, "transform", "mutate", undefined, input);
      },
    );
    await this.observePhase(event, context, state, input, []);
    await this.terminalAllow(event, context, state, input);

    return {
      event: "input",
      decision: state.decision,
      reason: state.reason,
      mutated,
      text: typeof input.text === "string" ? input.text : undefined,
      ...(images !== undefined ? { images } : {}),
    };
  }

  private async dispatchToolCall(event: NormalizedEvent, context: DispatchContext): Promise<ToolCallDispatchResult> {
    let input = cloneDeep(event.input);
    const state: PhaseState = { decision: "allow" };
    let mutated = false;
    const contextAdditions: string[] = [];

    await this.runPhase(
      "guard", event, context, state, input,
      (module) => module.tool_call?.guard?.bind(module.tool_call),
      async (moduleId, result) => {
        if (result.decision !== "deny") return;
        state.decision = "deny";
        state.reason = result.reason ?? `Denied by ${moduleId}`;
        await this.writeDecision(moduleId, event, context, "guard", "deny", state.reason, input);
      },
    );
    await this.runPhase(
      "transform", event, context, state, () => input,
      (module) => module.tool_call?.transform?.bind(module.tool_call),
      async (moduleId, result) => {
        input = cloneDeep(result.input);
        mutated = true;
        await this.writeDecision(moduleId, event, context, "transform", "mutate", undefined, input);
      },
    );
    await this.runPhase(
      "internal-final", event, context, state, () => input,
      (module) => module.tool_call?.internalFinal?.bind(module.tool_call),
      async (moduleId, result) => {
        if (result.decision !== "deny") return;
        state.decision = "deny";
        state.reason = result.reason ?? `Denied by ${moduleId}`;
        await this.writeDecision(moduleId, event, context, "internal-final", "deny", state.reason, input);
      },
    );
    await this.runPhase(
      "context", event, context, state, () => input,
      (module) => module.tool_call?.context?.bind(module.tool_call),
      (moduleId, result) => {
        contextAdditions.push(...(typeof result.context === "string" ? [result.context] : result.context));
      },
    );
    await this.observePhase(event, context, state, input, contextAdditions);
    if (state.decision === "allow") this.queuedContext.push(...contextAdditions);
    await this.terminalAllow(event, context, state, input);

    return { event: "tool_call", decision: state.decision, reason: state.reason, mutated, input, contextAdditions };
  }

  private async dispatchToolResult(event: NormalizedEvent, context: DispatchContext): Promise<ToolResultDispatchResult> {
    const input = cloneDeep(event.input);
    const state: PhaseState = { decision: "allow" };
    const patch: ToolResultPatch = {};
    let patched = false;
    const contextAdditions: string[] = [];
    const current = (): ToolResultPatch => ({
      content: patch.content !== undefined ? patch.content : event.payload.content,
      details: patch.details !== undefined ? patch.details : event.payload.details,
      isError: patch.isError !== undefined ? patch.isError : event.isError,
    });

    await this.runPhase(
      "transform", event, context, state, input,
      (module) => module.tool_result?.patch?.bind(module.tool_result),
      async (moduleId, result) => {
        if (result.content !== undefined) patch.content = cloneDeep(result.content);
        if (result.details !== undefined) patch.details = cloneDeep(result.details);
        if (result.isError !== undefined) patch.isError = result.isError;
        patched = true;
        await this.writeDecision(moduleId, event, context, "transform", "mutate", undefined, input);
      },
      () => frozenView(current()),
    );
    await this.runPhase(
      "context", event, context, state, input,
      (module) => module.tool_result?.context?.bind(module.tool_result),
      (moduleId, result) => {
        contextAdditions.push(...(typeof result.context === "string" ? [result.context] : result.context));
      },
      () => frozenView(current()),
    );
    await this.observePhase(event, context, state, input, contextAdditions);
    if (state.decision === "allow") this.queuedContext.push(...contextAdditions);
    await this.terminalAllow(event, context, state, input);

    return {
      event: "tool_result",
      decision: state.decision,
      reason: state.reason,
      ...(patched && state.decision === "allow" ? { patch } : {}),
      contextAdditions,
    };
  }

  private async dispatchContext(event: NormalizedEvent, context: DispatchContext): Promise<ContextDispatchResult> {
    let messages = cloneDeep(Array.isArray(event.input.messages) ? event.input.messages : []);
    const state: PhaseState = { decision: "allow" };
    let mutated = false;

    await this.runPhase(
      "transform", event, context, state, () => ({ messages }),
      (module) => module.context?.transform?.bind(module.context),
      async (moduleId, result) => {
        messages = cloneDeep(result.messages);
        mutated = true;
        await this.writeDecision(moduleId, event, context, "transform", "mutate", undefined, { messages });
      },
    );
    await this.observePhase(event, context, state, { messages }, []);
    const queuedContext = state.decision === "allow" ? this.queuedContext.splice(0) : [];
    await this.terminalAllow(event, context, state, { messages });

    return {
      event: "context",
      decision: state.decision,
      reason: state.reason,
      ...(mutated && state.decision === "allow" ? { messages } : {}),
      queuedContext,
    };
  }

  private async dispatchObserveOnly(event: NormalizedEvent, context: DispatchContext): Promise<DispatchResult> {
    const state: PhaseState = { decision: "allow" };
    await this.observePhase(event, context, state, cloneDeep(event.input), []);
    return { event: event.type as ObserveOnlyEventType, decision: "allow" };
  }

  /**
   * The one shared phase-runner (SLICE-0008): owns deny short-circuiting and
   * the failure policy in one place — optional-module failures isolate and
   * degrade runtime health only, required-module failures deny pre-execution,
   * and observe failures never block.
   */
  private async runPhase<R>(
    phase: HookPhase,
    event: NormalizedEvent,
    context: DispatchContext,
    state: PhaseState,
    input: Record<string, unknown> | (() => Record<string, unknown>),
    select: (module: HookModule) => ((invocation: HookInvocation) => void | R | Promise<void | R>) | undefined,
    apply: (moduleId: string, result: R) => void | Promise<void>,
    resultView?: () => Readonly<ToolResultPatch>,
  ): Promise<void> {
    for (const module of this.modules) {
      const handler = select(module);
      if (!handler) continue;
      if (phase !== "observe" && state.decision === "deny") continue;
      const currentInput = typeof input === "function" ? input() : input;
      try {
        const invocation: HookInvocation = {
          event,
          input: frozenView(currentInput),
          context,
          ...(resultView ? { result: resultView() } : {}),
        };
        const result = await handler(invocation);
        if (result !== undefined && result !== null) await apply(module.id, result as R);
      } catch (error) {
        const failure = `${module.id} ${phase} failed: ${message(error)}`;
        this.runtimeFailure = failure;
        await this.writeDecision(module.id, event, context, phase, "module-failure", failure, currentInput);
        if (phase !== "observe" && this.requiredById.get(module.id) !== false) {
          state.decision = "deny";
          state.reason = failure;
        }
      }
    }
  }

  private async observePhase(
    event: NormalizedEvent,
    context: DispatchContext,
    state: PhaseState,
    input: Record<string, unknown>,
    contextAdditions: readonly string[],
  ): Promise<void> {
    for (const module of this.modules) {
      const handler = observeHandlerOf(module, event.type);
      if (!handler) continue;
      try {
        await handler({
          event,
          input: frozenView(input),
          context,
          decision: state.decision,
          reason: state.reason,
          contextAdditions,
        });
      } catch (error) {
        const failure = `${module.id} observe failed: ${message(error)}`;
        this.runtimeFailure = failure;
        await this.writeDecision(module.id, event, context, "observe", "module-failure", failure, input);
      }
    }
  }

  private async terminalAllow(
    event: NormalizedEvent,
    context: DispatchContext,
    state: PhaseState,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (state.decision !== "allow" || !EFFECT_BEARING.has(event.type)) return;
    await this.writeDecision("host", event, context, "host", "allow", undefined, input);
  }

  private isSafeMode(): boolean {
    return this.config === undefined || this.configFailure !== undefined && this.modules.length === 0;
  }

  private async safeModeDispatch(event: NormalizedEvent, context: DispatchContext): Promise<DispatchResult> {
    if (event.type === "tool_call") {
      const allow = READ_ONLY_TOOLS.has(event.toolName ?? "") && event.provenance?.source === "builtin";
      const reason = allow
        ? undefined
        : "Denied by Read-Only Safe Mode: trusted global configuration is invalid and only built-in read-only tools with trusted provenance may run";
      if (!allow) await this.writeDecision("host", event, context, "host", "deny", reason, event.input);
      return {
        event: "tool_call",
        decision: allow ? "allow" : "deny",
        reason,
        mutated: false,
        input: cloneDeep(event.input),
        contextAdditions: [],
      };
    }
    switch (event.type) {
      case "input":
        return { event: "input", decision: "allow", mutated: false, text: typeof event.input.text === "string" ? event.input.text : undefined };
      case "tool_result":
        return { event: "tool_result", decision: "allow", contextAdditions: [] };
      case "context":
        return { event: "context", decision: "allow", queuedContext: [] };
      default:
        return { event: event.type as ObserveOnlyEventType, decision: "allow" };
    }
  }

  private async writeDecision(
    moduleId: string,
    event: NormalizedEvent,
    context: DispatchContext,
    phase: HookPhase | "host",
    decision: AuditRecord["decision"],
    reason: string | undefined,
    input: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      timestamp: new Date().toISOString(),
      sessionId: context.sessionManager?.getSessionId?.() ?? context.sessionManager?.getSessionFile?.(),
      moduleId,
      eventType: event.type,
      phase,
      decision,
      ...(reason ? { reason } : {}),
      inputSummary: input,
    });
  }
}

function observeHandlerOf(module: HookModule, type: NormalizedEvent["type"]) {
  const group = module[type];
  return group?.observe?.bind(group);
}

function defaultConfigPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-hooks.jsonc");
}

function emptyPhaseOrder(): Record<HookPhase, string[]> {
  return { guard: [], transform: [], "internal-final": [], context: [], observe: [] };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
