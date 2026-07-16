import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeEvent } from "./events.js";
import { createHookHost, type CreateHookHostOptions } from "./host.js";
import type { DispatchContext } from "./types.js";

/**
 * The Pi seam (SLICE-0008): one binding per exposed event. Each binding
 * normalizes in, dispatches, and applies the typed result to Pi's exact public
 * result shape. The five observe-only events apply nothing.
 */
export function createPiHooksExtension(options: CreateHookHostOptions = {}) {
  return async function piHooksExtension(pi: ExtensionAPI): Promise<void> {
    const host = await createHookHost(options);
    host.bindPi({ registerTool: (tool) => pi.registerTool(tool as never) });

    pi.on("input", async (event, ctx) => {
      const result = await host.dispatch(normalizeEvent("input", record(event)), ctx as DispatchContext);
      if (result.event !== "input") return;
      if (result.decision === "deny") return { action: "handled" as const };
      if (result.mutated && result.text !== undefined) {
        return {
          action: "transform" as const,
          text: result.text,
          ...(result.images !== undefined ? { images: result.images } : {}),
        };
      }
    });

    pi.on("tool_call", async (event, ctx) => {
      const normalized = normalizeEvent("tool_call", record(event));
      normalized.provenance = resolveProvenance(pi, normalized.toolName);
      const result = await host.dispatch(normalized, ctx as DispatchContext);
      if (result.event !== "tool_call") return;
      if (result.mutated) replaceInput(event.input as Record<string, unknown>, result.input);
      if (result.decision === "deny") return { block: true, reason: result.reason };
    });

    pi.on("tool_result", async (event, ctx) => {
      const result = await host.dispatch(normalizeEvent("tool_result", record(event)), ctx as DispatchContext);
      if (result.event !== "tool_result") return;
      if (result.patch) return result.patch;
    });

    pi.on("context", async (event, ctx) => {
      const result = await host.dispatch(normalizeEvent("context", record(event)), ctx as DispatchContext);
      if (result.event !== "context") return;
      const queued = result.queuedContext.map((text) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text }],
        timestamp: Date.now(),
      }));
      if (result.messages === undefined && queued.length === 0) return;
      const base = result.messages ?? event.messages;
      return { messages: [...base, ...queued] };
    });

    pi.on("agent_end", async (event, ctx) => {
      await host.dispatch(normalizeEvent("agent_end", record(event)), ctx as DispatchContext);
    });
    pi.on("session_start", async (event, ctx) => {
      await host.dispatch(normalizeEvent("session_start", record(event)), ctx as DispatchContext);
    });
    pi.on("session_shutdown", async (event, ctx) => {
      await host.dispatch(normalizeEvent("session_shutdown", record(event)), ctx as DispatchContext);
    });
    pi.on("session_before_compact", async (event, ctx) => {
      await host.dispatch(normalizeEvent("session_before_compact", record(event)), ctx as DispatchContext);
    });
    pi.on("session_compact", async (event, ctx) => {
      await host.dispatch(normalizeEvent("session_compact", record(event)), ctx as DispatchContext);
    });

    pi.registerCommand("hooks", {
      description: "Show Hook Host status",
      handler: async (args, ctx) => {
        if (args.trim() !== "status") {
          ctx.ui.notify("Usage: /hooks status", "info");
          return;
        }
        ctx.ui.notify(JSON.stringify(host.status()), "info");
      },
    });
  };
}

function resolveProvenance(pi: ExtensionAPI, toolName: string | undefined): { source: string; path?: string } | undefined {
  if (!toolName) return undefined;
  // Trust requires the *active* tool set: getAllTools membership alone is not
  // provenance for a tool Pi would not currently execute.
  if (!pi.getActiveTools().includes(toolName)) return undefined;
  const active = pi.getAllTools().find((tool) => tool.name === toolName);
  return active ? { source: active.sourceInfo.source, path: active.sourceInfo.path } : undefined;
}

function replaceInput(target: Record<string, unknown>, replacement: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
