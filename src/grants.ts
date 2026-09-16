import type { TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HookModule } from "./types.js";

/**
 * The capability-grant substrate (SLICE-0009 / PRD-0002): a Capability Provider
 * declares exactly the finite grant kinds it needs, and the Host hands it only
 * that typed API subset. Undeclared grants are unexpressible by type and refused
 * at runtime — this is the SLICE-0007/0008 typed-effect guarantee generalized to
 * the whole provider surface, keeping the BUG-0002 class (accepted-then-discarded
 * capability) closed.
 */
export const GRANT_KINDS = ["events", "tools", "commands", "process", "ui", "interaction"] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

export interface CapabilityManifest {
  id: string;
  version: string;
  grants: readonly GrantKind[];
  /** TypeBox schema validating the provider's configuration entry. */
  configSchema?: TSchema;
  /** Whether project-level configuration may enable/configure this provider. */
  projectConfigurable?: boolean;
}

/** events grant: contribute Hook Modules on the unchanged nine-event contract. */
export interface EventsGrant {
  registerModule(module: HookModule): void;
}
/** tools grant: register an LLM-callable tool that flows through the Host boundary. */
export interface ToolsGrant {
  registerTool(tool: ToolDefinition): void;
}
/** commands grant: register a slash command. */
export interface CommandsGrant {
  registerCommand(name: string, command: ProviderCommand): void;
}
/** process grant: spawn a Host-lifecycle-owned long-lived child process. */
export interface ProcessGrant {
  spawn(spec: ProcessSpec): void;
  run(spec: ProcessRunSpec): Promise<string>;
}
/** ui grant: status/widget surfaces. */
export interface UiGrant {
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, lines: readonly string[] | undefined): void;
}

export interface ConfirmRequest {
  title: string;
  message: string;
}
export type ConfirmOutcome = "approved" | "denied";
/**
 * interaction grant (ADR-0005): confirm-only subset of the interaction family;
 * a later slice (SLICE-0020) extends it. The Host binds it to the live session
 * UI. When no UI is attached (hasUI false) confirm resolves immediately to the
 * caller-supplied noUiOutcome — fail-closed when the caller passes "denied".
 */
export interface InteractionGrant {
  confirm(request: ConfirmRequest, options: { noUiOutcome: ConfirmOutcome }): Promise<ConfirmOutcome>;
}

export interface ProviderCommand {
  description?: string;
  handler: (args: string, ctx: unknown) => void | Promise<void>;
}

export interface ProcessSpec {
  id: string;
  command: string;
  args?: readonly string[];
}

export interface ProcessRunSpec {
  command: string;
  args?: readonly string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface GrantApiMap {
  events: EventsGrant;
  tools: ToolsGrant;
  commands: CommandsGrant;
  process: ProcessGrant;
  ui: UiGrant;
  interaction: InteractionGrant;
}

/** The typed facade: only the declared grant kinds are present as properties. */
export type GrantFacade<G extends GrantKind> = { [K in G]: GrantApiMap[K] };

export interface CapabilityProvider<G extends GrantKind> {
  manifest: CapabilityManifest & { grants: readonly G[] };
  activate(facade: GrantFacade<G>, config: unknown): void | Promise<void>;
}

/**
 * Erased storage type for a provider of any grant set. Used only where the
 * Host holds a heterogeneous list; authors never write it — `defineProvider`
 * infers the narrow grant set. There is deliberately no all-grants default on
 * `CapabilityProvider`, so a directly annotated `CapabilityProvider<"events">`
 * cannot reach `facade.tools`.
 */
export type AnyCapabilityProvider = CapabilityProvider<GrantKind>;

/**
 * Identity helper that pins the grant literal set so `activate` receives a
 * facade typed to exactly the declared grants — reaching for an undeclared
 * grant is a compile error.
 */
export function defineProvider<const G extends GrantKind>(provider: CapabilityProvider<G>): CapabilityProvider<G> {
  return provider;
}

/** Full runtime wiring: every grant kind, granted or not. */
export type GrantWiring = { [K in GrantKind]: GrantApiMap[K] };

export type RefuseFn = (grant: GrantKind, method: string) => void;

/**
 * Build the runtime facade a provider is activated with. Granted kinds get the
 * real wiring; ungranted kinds get a refusal proxy that audits the attempt and
 * throws — backing the type boundary for dynamically loaded providers that cast
 * around it (PRD-0002: "runtime checks back the type boundary").
 */
export function buildFacade(grants: readonly GrantKind[], wiring: GrantWiring, refuse: RefuseFn): GrantWiring {
  const granted = new Set<GrantKind>(grants);
  const pick = <K extends GrantKind>(kind: K): GrantApiMap[K] =>
    granted.has(kind) ? wiring[kind] : (refusalGrant(kind, refuse) as GrantApiMap[K]);
  return {
    events: pick("events"),
    tools: pick("tools"),
    commands: pick("commands"),
    process: pick("process"),
    ui: pick("ui"),
    interaction: pick("interaction"),
  };
}

function refusalGrant(kind: GrantKind, refuse: RefuseFn): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return (): never => {
          refuse(kind, String(prop));
          throw new Error(`Capability refused: provider did not declare the "${kind}" grant`);
        };
      },
    },
  );
}
