import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeEvent } from "./events.js";
import { createHookHost, type CreateHookHostOptions } from "./host.js";
import type { DispatchContext } from "./types.js";

export function createPiHooksExtension(options: CreateHookHostOptions = {}) {
  return async function piHooksExtension(pi: ExtensionAPI): Promise<void> {
    const host = await createHookHost(options);

    pi.on("tool_call", async (event, ctx) => {
      const result = await host.dispatch(normalizeEvent("tool_call", record(event)), ctx as DispatchContext);
      replaceInput(event.input as Record<string, unknown>, result.input);
      if (result.decision === "deny") return { block: true, reason: result.reason };
    });

    pi.on("input", async (event, ctx) => {
      await host.dispatch(normalizeEvent("input", record(event)), ctx as DispatchContext);
    });
    pi.on("tool_result", async (event, ctx) => {
      await host.dispatch(normalizeEvent("tool_result", record(event)), ctx as DispatchContext);
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

function replaceInput(target: Record<string, unknown>, replacement: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
