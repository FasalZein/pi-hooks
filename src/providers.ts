import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { GlobalConfig, ProviderConfigEntry } from "./config.js";
import {
  buildFacade,
  GRANT_KINDS,
  type CapabilityProvider,
  type GrantKind,
  type GrantWiring,
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
  /** events-grant contributions merged into the module dispatch path. */
  modules: HookModule[];
  /** Requiredness per contributed module id, inherited from its provider entry. */
  requiredByModuleId: Map<string, boolean>;
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
  available: readonly CapabilityProvider[],
  config: GlobalConfig,
): Promise<ProviderActivation> {
  const authorized = new Map<string, ProviderConfigEntry>();
  for (const entry of config.providers) authorized.set(entry.id, entry);

  const activation: ProviderActivation = {
    modules: [],
    requiredByModuleId: new Map(),
    tools: [],
    commands: [],
    processes: [],
    uiOps: [],
    providers: [],
    records: [],
  };

  for (const provider of available) {
    const manifest = provider.manifest;
    const entry = authorized.get(manifest.id);
    if (!entry) continue; // not authorized by trusted global configuration

    const required = entry.required !== false;
    const enabled = entry.enabled !== false;
    const prepared: PreparedProvider = {
      id: manifest.id,
      version: manifest.version,
      grants: manifest.grants,
      source: "global",
      enabled,
      required,
      health: "healthy",
    };
    activation.providers.push(prepared);

    const manifestError = validateManifest(provider);
    if (manifestError) {
      degrade(prepared, activation, `manifest invalid: ${manifestError}`);
      continue;
    }
    if (!enabled) continue;

    const wiring = collectingWiring(prepared, activation);
    const refuse = (grant: GrantKind, method: string): void => {
      activation.records.push(refusalRecord(manifest.id, grant, method));
    };
    const facade = buildFacade(manifest.grants, wiring, refuse);

    try {
      await provider.activate(facade as never, entry.config);
    } catch (error) {
      degrade(prepared, activation, `activation failed: ${message(error)}`);
    }
  }

  return activation;
}

function validateManifest(provider: CapabilityProvider): string | undefined {
  const manifest = provider.manifest as Partial<CapabilityProvider["manifest"]>;
  if (typeof manifest?.id !== "string" || manifest.id.length === 0) return "missing id";
  if (typeof manifest.version !== "string" || manifest.version.length === 0) return "missing version";
  if (!Array.isArray(manifest.grants) || manifest.grants.length === 0) return "no grants declared";
  for (const grant of manifest.grants) {
    if (!GRANT_KINDS.includes(grant as GrantKind)) return `unknown grant: ${String(grant)}`;
  }
  if (typeof provider.activate !== "function") return "missing activate";
  return undefined;
}

function collectingWiring(prepared: PreparedProvider, activation: ProviderActivation): GrantWiring {
  const providerId = prepared.id;
  return {
    events: {
      registerModule: (module) => {
        activation.modules.push(module);
        activation.requiredByModuleId.set(module.id, prepared.required);
      },
    },
    tools: { registerTool: (tool) => activation.tools.push({ providerId, tool }) },
    commands: { registerCommand: (name, command) => activation.commands.push({ providerId, name, command }) },
    process: { spawn: (spec) => activation.processes.push({ providerId, spec }) },
    ui: {
      setStatus: (key, text) => activation.uiOps.push({ providerId, kind: "status", key, text }),
      setWidget: (key, lines) => activation.uiOps.push({ providerId, kind: "widget", key, lines }),
    },
  };
}

function degrade(prepared: PreparedProvider, activation: ProviderActivation, failure: string): void {
  prepared.health = "degraded";
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
