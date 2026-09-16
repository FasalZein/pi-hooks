import { homedir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit.js";
import { cloneDeep, frozenView, safeFrozenView } from "./isolate.js";
import { loadGlobalConfig, type GlobalConfig, type ProviderConfigEntry } from "./config.js";
import { confirmApproval } from "./hooks-ui.js";
import { preparePolicy } from "./policy.js";
import { spawn, type ChildProcess } from "node:child_process";
import { resolveOrder } from "./order.js";
import { activateProviders, type PreparedProvider, type ProviderActivation } from "./providers.js";
import type { AnyCapabilityProvider, InteractionGrant, ProviderCommand } from "./grants.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
  ObserveInvocation,
  PiContextMessages,
  PiInputImages,
  ObserveOnlyEventType,
  ToolCallDispatchResult,
  ToolResultDispatchResult,
  ToolResultPatch,
} from "./types.js";

const EFFECT_BEARING = new Set<NormalizedEvent["type"]>(["input", "tool_call", "tool_result", "context"]);
const FINAL_BOUNDARY = "Authoritative only inside this Host tool_call handler; a later Pi extension can still mutate input before execution.";
const PROCESS_GRANT_NOTE = "process-grant child processes run with the Pi process's OS permissions, outside the observed tool_call boundary; the Host best-effort-terminates their process group at shutdown but does not sandbox them, and a child that re-parents into its own session can escape.";

export interface CreateHookHostOptions {
  configPath?: string;
  /** Explicit composition defaults; user entries override them by id. */
  providerDefaults?: readonly ProviderConfigEntry[];
  preset?: string;
  modules?: readonly HookModule[];
  providers?: readonly AnyCapabilityProvider[];
}

/** Real Pi bindings supplied by the adapter to flush granted registrations. */
export interface PiGrantBindings {
  registerTool(tool: ToolDefinition): void;
  registerCommand(name: string, command: ProviderCommand): void;
}

export interface HookHost {
  dispatch(event: NormalizedEvent, context: DispatchContext): Promise<DispatchResult>;
  status(): HostStatus;
  /** Flush provider grant registrations that require the real Pi surface. */
  bindPi(bindings: PiGrantBindings): void;
}

export async function createHookHost(options: CreateHookHostOptions = {}): Promise<HookHost> {
  const configPath = options.configPath ?? defaultConfigPath();
  const available = [...(options.modules ?? [])];
  let config: GlobalConfig | undefined;
  let modules: HookModule[] = [];
  let phaseOrder = emptyPhaseOrder();
  let required = new Map<string, boolean>();
  let failure: string | undefined;
  let preparationFailures: string[] = [];

  try {
    config = await loadGlobalConfig(configPath);
    const configured = new Set(config.providers.map((entry) => entry.id));
    config.providers = [...(options.providerDefaults ?? []).filter((entry) => !configured.has(entry.id)), ...config.providers];
  } catch (error) {
    failure = message(error);
  }

  const interaction = createInteractionBroker(config?.rendering !== false && options.preset !== undefined);
  let activation: ProviderActivation | undefined;
  if (config) {
    activation = await activateProviders(options.providers ?? [], config, interaction);
    const policy = preparePolicy(available, config);
    if (policy.ok) {
      ({ modules, phaseOrder, required } = policy);
      preparationFailures = policy.failures;
      if (activation.modules.length > 0) {
        try {
          const combined = resolveOrder([...policy.modules, ...activation.modules]);
          modules = combined.modules;
          phaseOrder = combined.phaseOrder;
          for (const [id, req] of activation.requiredByModuleId) required.set(id, req);
        } catch (error) {
          failure = message(error);
          modules = [];
        }
      }
    } else {
      failure = policy.failure;
    }
  }

  const audit = new AuditLog(config?.audit?.path, config?.audit?.includeAllows);
  if (activation) for (const record of activation.records) await audit.record(record);
  const requiredFailure = activation?.providers.find((provider) => provider.required && provider.health === "degraded");
  const activationFailure = failure ?? (requiredFailure ? `provider ${requiredFailure.id}: ${requiredFailure.lastFailure}` : undefined);
  if (activationFailure) {
    modules = [];
    phaseOrder = emptyPhaseOrder();
  }
  const host = new Host(configPath, config, modules, phaseOrder, required, audit, failure, activation, interaction, activationFailure, preparationFailures, options.preset);
  if (activationFailure) await host.recordInactive(activationFailure);
  return host;
}

interface PhaseState {
  decision: HookDecision;
  reason?: string;
}

interface InteractionBroker extends InteractionGrant {
  /** Host-owned: rebind the broker to the DispatchContext of the current dispatch. */
  setContext(context: DispatchContext): void;
}

/**
 * Live-bound interaction broker (SLICE-0011 item 3): the Host updates the
 * current DispatchContext at each dispatch, and confirm resolves through the
 * real ctx.ui when a UI is attached. With no UI (hasUI false, or no dispatch
 * context yet) the caller-supplied noUiOutcome returns immediately — nothing
 * ever waits on an absent operator.
 */
function createInteractionBroker(rendering: boolean): InteractionBroker {
  let current: DispatchContext | undefined;
  return {
    setContext(context) {
      current = context;
    },
    async confirm(request, options) {
      const ui = current?.hasUI ? current.ui : undefined;
      if (rendering && ui?.custom) return (await confirmApproval(ui, request)) ? "approved" : "denied";
      if (!ui?.confirm) return options.noUiOutcome;
      return (await ui.confirm(request.title, request.message)) ? "approved" : "denied";
    },
  };
}

class Host implements HookHost {
  private runtimeFailure?: string;
  private readonly configFailure?: string;
  /** Queued module context effects, drained exactly once on the next real context event. */
  private readonly queuedContext: string[] = [];

  private readonly providers: PreparedProvider[];
  private readonly pendingTools: ProviderActivation["tools"];
  private readonly pendingCommands: ProviderActivation["commands"];
  private readonly pendingProcesses: ProviderActivation["processes"];
  private readonly pendingUiOps: ProviderActivation["uiOps"];
  private readonly children: Array<{ child: ChildProcess; providerId: string; specId: string }> = [];
  private readonly providerByModuleId: Map<string, string>;
  private processesStarted = false;

  constructor(
    private readonly configPath: string,
    private readonly config: GlobalConfig | undefined,
    private readonly modules: HookModule[],
    private readonly phaseOrder: Record<HookPhase, string[]>,
    private readonly requiredById: Map<string, boolean>,
    private readonly audit: AuditLog,
    failure: string | undefined,
    activation: ProviderActivation | undefined,
    private readonly interaction: InteractionBroker,
    private readonly activationFailure: string | undefined,
    preparationFailures: string[],
    private readonly preset?: string,
  ) {
    this.configFailure = failure;
    this.providers = activation?.providers ?? [];
    this.pendingTools = activation?.tools ?? [];
    this.pendingCommands = activation?.commands ?? [];
    this.pendingProcesses = activation?.processes ?? [];
    this.pendingUiOps = activation?.uiOps ?? [];
    this.providerByModuleId = activation?.providerByModuleId ?? new Map();
    const failures = this.providers.filter((provider) => provider.health === "degraded")
      .map((provider) => `provider ${provider.id} ${provider.lastFailure ?? "isolated"}`);
    this.runtimeFailure = [...preparationFailures, ...failures].join("; ") || undefined;
  }

  bindPi(bindings: PiGrantBindings): void {
    if (this.isInactive()) return;
    for (const registration of this.pendingTools) bindings.registerTool(registration.tool);
    for (const registration of this.pendingCommands) bindings.registerCommand(registration.name, registration.command);
  }

  /**
   * process grant: deferred start on session_start; the Host owns the whole
   * process tree. Children are spawned detached as process-group leaders so
   * shutdown can signal the entire group (child + grandchildren), and spawn
   * failures degrade the owning provider instead of being swallowed.
   */
  private startProcesses(): void {
    if (this.isInactive() || this.processesStarted) return;
    this.processesStarted = true;
    for (const { providerId, spec } of this.pendingProcesses) {
      try {
        const child = spawn(spec.command, [...(spec.args ?? [])], { stdio: "ignore", detached: true });
        child.on("error", (error) => {
          this.degradeProvider(providerId, `process ${spec.id} failed: ${message(error)}`);
          void this.audit.record(this.processRecord(providerId, spec.id, "module-failure", `process ${spec.id} error: ${message(error)}`));
        });
        child.on("exit", () => {
          // The leader exited: eagerly reap any same-group descendants now, while
          // the group is still non-empty and its id (the leader pid) cannot yet
          // be reused. This closes the common daemonize-then-exit leak that a
          // shutdown-time-only kill would miss.
          this.reapGroup(child.pid);
        });
        child.unref();
        this.children.push({ child, providerId, specId: spec.id });
        void this.audit.record(this.processRecord(providerId, spec.id, "allow", `process ${spec.id} started`));
      } catch (error) {
        this.degradeProvider(providerId, `process ${spec.id} spawn failed: ${message(error)}`);
        void this.audit.record(this.processRecord(providerId, spec.id, "module-failure", `process ${spec.id} spawn failed: ${message(error)}`));
      }
    }
  }

  /**
   * Best-effort termination of every provider process group at shutdown. While
   * a child's group leader is alive this reaps the whole tree; the per-child
   * exit handler reaps groups whose leader exited early. This is not OS
   * containment (ADR-0001): a child that re-parents into its own session can
   * still escape, so the guarantee is best-effort, not absolute.
   */
  private killProcesses(): void {
    for (const { child } of this.children.splice(0)) {
      const pid = child.pid;
      if (pid === undefined) continue;
      if (child.exitCode !== null || child.signalCode !== null) {
        this.reapGroup(pid);
        continue;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }

  /** Signal a whole process group by leader pid; ESRCH (empty group) is fine. */
  private reapGroup(pid: number | undefined): void {
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* group already empty or gone */
    }
  }

  private degradeProvider(id: string, failure: string): void {
    const provider = this.providers.find((candidate) => candidate.id === id);
    if (provider && provider.health === "healthy") {
      provider.health = "degraded";
      provider.lastFailure = failure;
    }
    this.runtimeFailure = failure;
  }

  private processRecord(provider: string, specId: string, decision: AuditRecord["decision"], reason: string): AuditRecord {
    return {
      timestamp: new Date().toISOString(),
      moduleId: "host",
      provider,
      eventType: "session_start",
      phase: "host",
      decision,
      reason: `${specId}: ${reason}`,
    };
  }

  /** ui grant: apply captured status/widget ops through the real Pi ctx.ui. */
  private flushUi(context: DispatchContext): void {
    if (this.isInactive() || !context.ui) return;
    for (const op of this.pendingUiOps) {
      if (op.kind === "status") context.ui.setStatus(op.key, op.text);
      else context.ui.setWidget?.(op.key, op.lines);
    }
  }

  async recordInactive(reason: string): Promise<void> {
    await this.audit.record({
      timestamp: new Date().toISOString(),
      moduleId: "host",
      eventType: "session_start",
      phase: "host",
      decision: "inactive",
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
      modules: [
        ...configured.map((entry) => ({ id: entry.id, enabled: enabledIds.has(entry.id), required: entry.required !== false })),
        ...this.modules.filter((module) => this.providerByModuleId.has(module.id)).map((module) => ({
          id: module.id, enabled: true, required: this.requiredById.get(module.id) !== false,
        })),
      ],
      providers: this.providers.map((provider) => ({
        id: provider.id,
        source: provider.source,
        grants: provider.grants,
        enabled: !this.isInactive() && provider.enabled,
        required: provider.required,
        health: provider.health,
        ...(provider.lastFailure ? { lastFailure: provider.lastFailure } : {}),
      })),
      phaseOrder: this.phaseOrder,
      activation: this.isInactive() ? "inactive" : "active",
      ...(this.preset ? { preset: this.preset } : {}),
      rendering: this.config?.rendering !== false,
      audit,
      finalInterceptor: { available: false, boundary: FINAL_BOUNDARY },
      grantBoundary: { processToolCallGated: false, note: PROCESS_GRANT_NOTE },
    };
  }

  async dispatch(event: NormalizedEvent, context: DispatchContext): Promise<DispatchResult> {
    this.interaction.setContext(context);
    if (event.type === "session_start") {
      this.startProcesses();
      this.flushUi(context);
    } else if (event.type === "session_shutdown") {
      this.killProcesses();
    }
    if (this.isInactive()) return this.passThrough(event);
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
    let images: PiInputImages | undefined;

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
      content: patch.content !== undefined ? patch.content : event.payload.content as ToolResultPatch["content"],
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
      () => ({ result: frozenView(current()) }),
    );
    await this.runPhase(
      "context", event, context, state, input,
      (module) => module.tool_result?.context?.bind(module.tool_result),
      (moduleId, result) => {
        contextAdditions.push(...(typeof result.context === "string" ? [result.context] : result.context));
      },
      () => ({ result: frozenView(current()) }),
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
    let messages = cloneDeep(Array.isArray(event.input.messages) ? event.input.messages : []) as PiContextMessages;
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
  private async runPhase<R, I extends HookInvocation = HookInvocation>(
    phase: HookPhase,
    event: NormalizedEvent,
    context: DispatchContext,
    state: PhaseState,
    input: Record<string, unknown> | (() => Record<string, unknown>),
    select: (module: HookModule) => ((invocation: I) => void | R | Promise<void | R>) | undefined,
    apply: (moduleId: string, result: R) => void | Promise<void>,
    extras?: () => Partial<I>,
  ): Promise<void> {
    for (const module of this.modules) {
      const handler = select(module);
      if (!handler) continue;
      if (phase !== "observe" && state.decision === "deny") continue;
      const currentInput = typeof input === "function" ? input() : input;
      try {
        const invocation = {
          // A fresh isolated view per handler: unfreezable leaves stay private.
          event: safeFrozenView(event),
          input: frozenView(currentInput),
          context,
          reportFailure: async (reason: string) => {
            const failure = `${module.id}: ${reason}`;
            this.runtimeFailure = failure;
            const owner = this.providerByModuleId.get(module.id);
            if (owner) this.degradeProvider(owner, failure);
            await this.writeDecision(module.id, event, context, phase, "module-failure", failure, currentInput);
          },
          addContext: (text: string) => { this.queuedContext.push(text); },
          ...(extras?.() ?? {}),
        } as I;
        const result = await handler(invocation);
        if (result !== undefined && result !== null) await apply(module.id, result as R);
      } catch (error) {
        const failure = `${module.id} ${phase} failed: ${message(error)}`;
        this.runtimeFailure = failure;
        const owner = this.providerByModuleId.get(module.id);
        if (owner) this.degradeProvider(owner, failure);
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
    await this.runPhase<void, ObserveInvocation>(
      "observe", event, context, state, input,
      (module) => observeHandlerOf(module, event.type),
      () => undefined,
      () => ({ decision: state.decision, reason: state.reason, contextAdditions: frozenView([...contextAdditions]) }),
    );
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

  private isInactive(): boolean {
    return this.activationFailure !== undefined;
  }

  private passThrough(event: NormalizedEvent): DispatchResult {
    if (event.type === "tool_call") {
      return {
        event: "tool_call",
        decision: "allow",
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
    const provider = this.providerByModuleId.get(moduleId);
    await this.audit.record({
      timestamp: new Date().toISOString(),
      sessionId: context.sessionManager?.getSessionId?.() ?? context.sessionManager?.getSessionFile?.(),
      moduleId,
      ...(provider ? { provider } : {}),
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
