import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { GlobalConfig, ProviderConfigEntry } from "./config.js";
import { validateModuleEvents } from "./events.js";
import { runProcess } from "./process-runner.js";
import {
  buildFacade,
  GRANT_KINDS,
  type AnyCapabilityProvider,
  type GrantKind,
  type GrantWiring,
  type InteractionGrant,
  type ProcessSpec,
  type ProviderCommand,
} from "./grants.js";
import type { AuditRecord, HookModule } from "./types.js";

export interface PreparedProvider {
  id: string;
  version: string;
  grants: readonly GrantKind[];
  source: string;
  enabled: boolean;
  required: boolean;
  health: "healthy" | "degraded";
  lastFailure?: string;
}

export interface ToolRegistration {
  providerId: string;
  tool: ToolDefinition;
}
export interface CommandRegistration {
  providerId: string;
  name: string;
  command: ProviderCommand;
}
export interface ProcessRegistration {
  providerId: string;
  spec: ProcessSpec;
}
export interface UiOp {
  providerId: string;
  kind: "status" | "widget";
  key: string;
  text?: string;
  lines?: readonly string[];
}

export interface ProviderActivation {
  runtime: { active: boolean };
  /** events-grant contributions merged into the module dispatch path. */
  modules: HookModule[];
  /** Requiredness per contributed module id, inherited from its provider entry. */
  requiredByModuleId: Map<string, boolean>;
  /** Provider attribution per contributed module id, for audit records. */
  providerByModuleId: Map<string, string>;
  tools: ToolRegistration[];
  commands: CommandRegistration[];
  processes: ProcessRegistration[];
  uiOps: UiOp[];
  providers: PreparedProvider[];
  /** Refusal / failure records to persist after activation. */
  records: AuditRecord[];
}

/**
 * Authorize, validate, and activate Capability Providers (SLICE-0009). Only
 * providers named in trusted global configuration activate; each receives a
 * facade holding exactly its declared grants. Manifest-invalid providers and
 * activation failures isolate to that provider with degraded health and never
 * affect the others.
 */
export async function activateProviders(
  available: readonly AnyCapabilityProvider[],
  config: GlobalConfig,
  interaction: InteractionGrant,
): Promise<ProviderActivation> {
  const authorized = new Map<string, ProviderConfigEntry>();
  for (const entry of config.providers) authorized.set(entry.id, entry);

  const activation: ProviderActivation = {
    runtime: { active: false },
    modules: [],
    requiredByModuleId: new Map(),
    providerByModuleId: new Map(),
    tools: [],
    commands: [],
    processes: [],
    uiOps: [],
    providers: [],
    records: [],
  };

  for (const provider of available) {
    // Snapshot the whole unknown provider defensively (surviving throwing
    // getters), then validate the snapshot, inside a per-provider guard, so one
    // malformed provider can never abort or mis-attribute another.
    let current: PreparedProvider | undefined;
    try {
      const snapshot = snapshotManifest(provider);
      const id = typeof snapshot.id === "string" && snapshot.id.length > 0 ? snapshot.id : undefined;
      if (id === undefined) continue; // cannot be authorized without a usable id
      const entry = authorized.get(id);
      if (!entry) continue; // not authorized by trusted global configuration

      current = {
        id,
        version: typeof snapshot.version === "string" ? snapshot.version : "",
        grants: Array.isArray(snapshot.grants) ? (snapshot.grants as GrantKind[]) : [],
        source: "global",
        enabled: entry.enabled !== false,
        required: entry.required !== false,
        health: "healthy",
      };
      activation.providers.push(current);

      if (!current.enabled) continue;
      const manifestError = validateSnapshot(snapshot, provider);
      if (manifestError) {
        degrade(current, activation, `manifest invalid: ${manifestError}`);
        continue;
      }

      const configError = validateProviderConfig(snapshot.configSchema as TSchema | undefined, entry.config);
      if (configError) {
        degrade(current, activation, `config invalid: ${configError}`);
        continue;
      }

      // Transactional activation: stage all grant outputs into a private buffer;
      // commit to shared state only if activate() completes. A provider that
      // registers and then throws leaves nothing behind.
      const staged = emptyActivation();
      const wiring = collectingWiring(current, staged, interaction, activation.runtime);
      // Refusals are security events: record them on the committed log immediately
      // so they survive an activation rollback (the refusal proxy throws after).
      const refuse = (grant: GrantKind, methodName: string): void => {
        activation.records.push(refusalRecord(id, grant, methodName));
      };
      const facade = buildFacade(current.grants, wiring, refuse);
      await provider.activate(facade as never, entry.config);
      commit(activation, staged);
    } catch (error) {
      // The throw belongs to the provider we were activating; its staged output
      // was discarded. Degrade only that provider, never a sibling.
      if (current && current.health === "healthy") degrade(current, activation, `activation failed: ${message(error)}`);
    }
  }

  return activation;
}

interface ManifestSnapshot {
  id?: unknown;
  version?: unknown;
  grants?: unknown;
  configSchema?: unknown;
  projectConfigurable?: unknown;
  accessError?: string;
}

const THREW = Symbol("getter-threw");

function safeGet(target: Record<string, unknown>, key: string): unknown {
  try {
    return target[key];
  } catch {
    return THREW;
  }
}

function snapshotManifest(provider: AnyCapabilityProvider): ManifestSnapshot {
  if (provider === null || typeof provider !== "object") return { accessError: "missing provider object" };
  const manifest = safeGet(provider as unknown as Record<string, unknown>, "manifest");
  if (manifest === THREW || !manifest || typeof manifest !== "object") return { accessError: "missing manifest" };
  const m = manifest as Record<string, unknown>;
  // Read each field in its own guard so one throwing getter (e.g. grants) never
  // loses the id we need to still isolate and attribute the provider.
  const snapshot: ManifestSnapshot = {};
  const errors: string[] = [];
  for (const key of ["id", "version", "grants", "configSchema", "projectConfigurable"] as const) {
    const value = safeGet(m, key);
    if (value === THREW) errors.push(`${key} getter threw`);
    else snapshot[key] = value;
  }
  if (errors.length > 0) snapshot.accessError = errors.join("; ");
  return snapshot;
}

function validateSnapshot(snapshot: ManifestSnapshot, provider: AnyCapabilityProvider): string | undefined {
  if (snapshot.accessError) return snapshot.accessError;
  if (typeof snapshot.version !== "string" || snapshot.version.length === 0) return "missing version";
  if (!Array.isArray(snapshot.grants) || snapshot.grants.length === 0) return "no grants declared";
  for (const grant of snapshot.grants) {
    if (!GRANT_KINDS.includes(grant as GrantKind)) return `unknown grant: ${String(grant)}`;
  }
  if (snapshot.configSchema !== undefined && (snapshot.configSchema === null || typeof snapshot.configSchema !== "object")) return "configSchema must be a TypeBox schema";
  if (snapshot.projectConfigurable !== undefined && typeof snapshot.projectConfigurable !== "boolean") return "projectConfigurable must be boolean";
  let activate: unknown;
  try {
    activate = (provider as { activate?: unknown }).activate;
  } catch {
    return "activate access threw";
  }
  if (typeof activate !== "function") return "missing activate";
  return undefined;
}

function emptyActivation(): ProviderActivation {
  return {
    runtime: { active: false },
    modules: [],
    requiredByModuleId: new Map(),
    providerByModuleId: new Map(),
    tools: [],
    commands: [],
    processes: [],
    uiOps: [],
    providers: [],
    records: [],
  };
}

function commit(target: ProviderActivation, staged: ProviderActivation): void {
  target.modules.push(...staged.modules);
  for (const [id, req] of staged.requiredByModuleId) target.requiredByModuleId.set(id, req);
  for (const [id, provider] of staged.providerByModuleId) target.providerByModuleId.set(id, provider);
  target.tools.push(...staged.tools);
  target.commands.push(...staged.commands);
  target.processes.push(...staged.processes);
  target.uiOps.push(...staged.uiOps);
  target.records.push(...staged.records);
}

function validateProviderConfig(schema: TSchema | undefined, config: unknown): string | undefined {
  if (!schema) return undefined;
  const check = Compile(schema);
  if (check.Check(config)) return undefined;
  const errors = [...Value.Errors(schema, config)].map((error) => {
    const path = error.instancePath || "/";
    const id = namedEntryAtPath(config, path);
    return `${id ? `entry ${id} ` : ""}${path}: ${error.message}`;
  });
  return providerConfigFailure(errors);
}

function providerConfigFailure(errors: string[]): string {
  const failure = errors.join("; ");
  return failure === "" ? "does not match provider config schema" : failure;
}

function namedEntryId(value: unknown): string | undefined {
  const id = Reflect.get(Object(value), "id");
  if (typeof id === "string") return id;
  return undefined;
}

function namedEntryAtPath(config: unknown, path: string): string | undefined {
  let current = config;
  let id = namedEntryId(current);
  for (const part of path.split("/").slice(1)) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    current = Reflect.get(Object(current), key);
    id = namedEntryId(current) ?? id;
  }
  return id;
}

function collectingWiring(prepared: PreparedProvider, activation: ProviderActivation, interaction: InteractionGrant, runtime: { active: boolean }): GrantWiring {
  const providerId = prepared.id;
  return {
    events: {
      registerModule: (module) => {
        validateModuleEvents(module);
        activation.modules.push(module);
        activation.requiredByModuleId.set(module.id, prepared.required);
        activation.providerByModuleId.set(module.id, prepared.id);
      },
    },
    tools: { registerTool: (tool) => activation.tools.push({ providerId, tool }) },
    commands: { registerCommand: (name, command) => activation.commands.push({ providerId, name, command }) },
    process: {
      spawn: (spec) => activation.processes.push({ providerId, spec }),
      run: (spec) => {
        if (!runtime.active || !prepared.enabled) return Promise.reject(new Error("Process execution requires an activated Host and Provider"));
        return runProcess(spec);
      },
    },
    ui: {
      setStatus: (key, text) => activation.uiOps.push({ providerId, kind: "status", key, text }),
      setWidget: (key, lines) => activation.uiOps.push({ providerId, kind: "widget", key, lines }),
    },
    // Live call surface, not a staged registration: confirm has no persistent
    // effect to roll back, so the broker is handed through directly.
    interaction,
  };
}

function degrade(prepared: PreparedProvider, activation: ProviderActivation, failure: string): void {
  prepared.health = "degraded";
  prepared.enabled = false;
  prepared.lastFailure = failure;
  activation.records.push({
    timestamp: new Date().toISOString(),
    moduleId: "host",
    provider: prepared.id,
    eventType: "session_start",
    phase: "host",
    decision: "module-failure",
    reason: `provider ${prepared.id} ${failure}`,
  });
}

function refusalRecord(providerId: string, grant: GrantKind, method: string): AuditRecord {
  return {
    timestamp: new Date().toISOString(),
    moduleId: "host",
    provider: providerId,
    eventType: "session_start",
    phase: "host",
    decision: "grant-refused",
    reason: `provider ${providerId} used undeclared ${grant}.${method}`,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
