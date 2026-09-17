import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text, type Component } from "@earendil-works/pi-tui";
import type { ConfirmRequest } from "./grants.js";
import type { DispatchContext, HostStatus } from "./types.js";

/** Rendering only: no rules, decisions, or configuration writes live here. */
export function statusText(status: HostStatus): string {
  const lines = [
    `Hooks: ${status.activation}`,
    `Preset: ${status.preset ?? "Bare Host"}`,
    `Configuration: ${status.configuration.health}`,
    `Runtime: ${status.runtime.health}`,
    `Audit: ${status.audit.health}`,
    `Source: ${status.configSource}`,
  ];
  for (const lane of [status.configuration, status.runtime, status.audit]) {
    if (lane.lastFailure) lines.push(lane.lastFailure);
  }
  lines.push("", "Providers");
  for (const provider of status.providers) {
    lines.push(`${provider.id}: ${provider.enabled ? "enabled" : "disabled"}, ${provider.health}`, `  Grants: ${provider.grants.join(", ")}`);
    if (provider.lastFailure) lines.push(`  ${provider.lastFailure}`);
  }
  if (!status.providers.length) lines.push("None");
  lines.push("", "Phase order");
  for (const [phase, ids] of Object.entries(status.phaseOrder)) lines.push(`${phase}: ${ids.join(" → ") || "none"}`);
  lines.push("", status.finalInterceptor.boundary, status.grantBoundary.note);
  return lines.join("\n");
}

export function statusPanel(status: HostStatus, theme: Theme, done: () => void, height: () => number): Component {
  let offset = 0;
  return {
    render(width) {
      const lines = new Text(statusText(status), 1, 0).render(width);
      const page = Math.max(1, height() - 2);
      offset = Math.min(offset, Math.max(0, lines.length - page));
      return [
        ...lines.slice(offset, offset + page),
        ...new Text(theme.fg("dim", "↑↓ scroll · enter or esc close"), 1, 0).render(width),
      ];
    },
    invalidate() {},
    handleInput(data) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c"))) done();
      else if (matchesKey(data, Key.down)) offset++;
      else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
    },
  };
}

export async function showStatus(status: HostStatus, ctx: ExtensionCommandContext): Promise<void> {
  if (!status.rendering || !ctx.hasUI || ctx.mode === "rpc" || !ctx.ui.custom) {
    ctx.ui.notify(JSON.stringify(status), "info");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    const panel = statusPanel(status, theme, () => done(), () => tui.terminal.rows);
    return { ...panel, handleInput(data: string) { panel.handleInput?.(data); tui.requestRender(); } };
  });
}

export function approvalPanel(request: ConfirmRequest, theme: Theme, done: (approved: boolean) => void): Component {
  const choices = new SelectList([
    { value: "deny", label: "Deny" },
    { value: "allow-once", label: "Allow once" },
  ], 2, {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("muted", text),
  });
  choices.onSelect = (item) => done(item.value === "allow-once");
  choices.onCancel = () => done(false);
  const container = new Container();
  container.addChild(new Text(`${request.title}\n\n${request.message}`, 1, 1));
  container.addChild(choices);
  return {
    render: (width) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput: (data) => {
      if (matchesKey(data, Key.ctrl("c"))) done(false);
      else choices.handleInput(data);
    },
  };
}

export async function confirmApproval(ui: NonNullable<DispatchContext["ui"]>, request: ConfirmRequest): Promise<boolean> {
  return ui.custom!<boolean>((tui, theme, _keys, done) => {
    const panel = approvalPanel(request, theme, done);
    return { ...panel, handleInput(data: string) { panel.handleInput?.(data); tui.requestRender(); } };
  });
}

/** A model-invisible transcript entry accompanies Pi's unchanged tool error. */
export function denialPanel(reason: string, theme: Theme): Component {
  return {
    render: (width) => new Text(`${theme.fg("error", "Hooks denied this call")}\n${reason}`, 1, 0).render(width),
    invalidate() {},
  };
}
