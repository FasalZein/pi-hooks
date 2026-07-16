import { homedir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit.js";
import { cloneDeep, frozenView } from "./isolate.js";
import { loadGlobalConfig, type GlobalConfig } from "./config.js";
import { preparePolicy } from "./policy.js";
import type { AuditRecord, DispatchContext, DispatchResult, HookModule, HookPhase, HostStatus, NormalizedEvent } from "./types.js";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EFFECT_BEARING = new Set<NormalizedEvent["type"]>(["input", "tool_call", "tool_result"]);
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

class Host implements HookHost {
  private degraded = false;
  private lastFailure?: string;

  constructor(
    private readonly configPath: string,
    private readonly config: GlobalConfig | undefined,
    private readonly modules: HookModule[],
    private readonly phaseOrder: Record<HookPhase, string[]>,
    private readonly requiredById: Map<string, boolean>,
    private readonly audit: AuditLog,
    failure: string | undefined,
  ) {
    this.lastFailure = failure;
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
    const valid = !this.lastFailure || this.config !== undefined && this.modules.length >= 0 && !this.isSafeMode();
    const configured = this.config?.modules ?? [];
    const enabledIds = new Set(this.modules.map((module) => module.id));
    const audit = this.audit.status();
    return {
      configSource: this.configPath,
      configHealth: valid ? "valid" : "invalid",
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
      modules: configured.map((entry) => ({
        id: entry.id,
        enabled: enabledIds.has(entry.id),
        required: entry.required !== false,
      })),
      phaseOrder: this.phaseOrder,
      mode: this.isSafeMode() ? "read-only-safe" : "normal",
      health: this.degraded || this.isSafeMode() || audit.health === "degraded" ? "degraded" : "healthy",
      audit,
      finalInterceptor: { available: false, boundary: FINAL_BOUNDARY },
    };
  }

  async dispatch(event: NormalizedEvent, context: DispatchContext): Promise<DispatchResult> {
    if (this.isSafeMode()) return this.safeModeDispatch(event, context);

    let input = cloneDeep(event.input);
    let decision: "allow" | "deny" = "allow";
    let reason: string | undefined;
    let mutated = false;
    const contextAdditions: string[] = [];

    for (const module of this.modules) {
      if (!module.guard || decision === "deny") continue;
      try {
        const result = await module.guard({ event, input: frozenView(input), context });
        if (result?.decision === "deny") {
          decision = "deny";
          reason = result.reason ?? `Denied by ${module.id}`;
          await this.writeDecision(module.id, event, context, "guard", "deny", reason, input);
        }
      } catch (error) {
        ({ decision, reason } = await this.handleFailure(module, event, context, "guard", error, decision, reason, input));
      }
    }

    for (const module of this.modules) {
      if (!module.transform || decision === "deny") continue;
      try {
        const result = await module.transform({ event, input: frozenView(input), context });
        if (result) {
          input = cloneDeep(result.input);
          mutated = true;
          await this.writeDecision(module.id, event, context, "transform", "mutate", undefined, input);
        }
      } catch (error) {
        ({ decision, reason } = await this.handleFailure(module, event, context, "transform", error, decision, reason, input));
      }
    }

    for (const module of this.modules) {
      if (!module.internalFinal || decision === "deny") continue;
      try {
        const result = await module.internalFinal({ event, input: frozenView(input), context });
        if (result?.decision === "deny") {
          decision = "deny";
          reason = result.reason ?? `Denied by ${module.id}`;
          await this.writeDecision(module.id, event, context, "internal-final", "deny", reason, input);
        }
      } catch (error) {
        ({ decision, reason } = await this.handleFailure(module, event, context, "internal-final", error, decision, reason, input));
      }
    }

    for (const module of this.modules) {
      if (!module.context || decision === "deny") continue;
      try {
        const result = await module.context({ event, input: frozenView(input), context });
        if (result) contextAdditions.push(...(typeof result.context === "string" ? [result.context] : result.context));
      } catch (error) {
        ({ decision, reason } = await this.handleFailure(module, event, context, "context", error, decision, reason, input));
      }
    }

    for (const module of this.modules) {
      if (!module.observe) continue;
      try {
        await module.observe({ event, input: frozenView(input), context, decision, reason, contextAdditions });
      } catch (error) {
        await this.handleFailure(module, event, context, "observe", error, decision, reason, input);
      }
    }

    if (decision === "allow" && EFFECT_BEARING.has(event.type)) {
      await this.writeDecision("host", event, context, "host", "allow", undefined, input);
    }

    return { decision, reason, mutated, input, contextAdditions };
  }

  private isSafeMode(): boolean {
    return this.config === undefined || this.lastFailure !== undefined && this.modules.length === 0;
  }

  private async safeModeDispatch(event: NormalizedEvent, context: DispatchContext): Promise<DispatchResult> {
    const allow = event.type !== "tool_call"
      || READ_ONLY_TOOLS.has(event.toolName ?? "") && event.provenance?.source === "builtin";
    const reason = allow
      ? undefined
      : "Denied by Read-Only Safe Mode: trusted global configuration is invalid and only built-in read-only tools with trusted provenance may run";
    if (!allow) await this.writeDecision("host", event, context, "host", "deny", reason, event.input);
    return {
      decision: allow ? "allow" : "deny",
      reason,
      mutated: false,
      input: cloneDeep(event.input),
      contextAdditions: [],
    };
  }

  private async handleFailure(
    module: HookModule,
    event: NormalizedEvent,
    context: DispatchContext,
    phase: HookPhase,
    error: unknown,
    decision: "allow" | "deny",
    reason: string | undefined,
    input: Record<string, unknown>,
  ): Promise<{ decision: "allow" | "deny"; reason?: string }> {
    const failure = `${module.id} ${phase} failed: ${message(error)}`;
    this.degraded = true;
    this.lastFailure = failure;
    await this.writeDecision(module.id, event, context, phase, "module-failure", failure, input);
    if (phase !== "observe" && this.requiredById.get(module.id) !== false) return { decision: "deny", reason: failure };
    return { decision, reason };
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

function defaultConfigPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-hooks.jsonc");
}

function emptyPhaseOrder(): Record<HookPhase, string[]> {
  return { guard: [], transform: [], "internal-final": [], context: [], observe: [] };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
