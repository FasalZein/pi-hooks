import { cloneDeep } from "./isolate.js";
import type { NormalizedEvent } from "./types.js";

const ALIASES: Record<string, NormalizedEvent["type"]> = {
  UserPromptSubmit: "input",
  PreToolUse: "tool_call",
  PostToolUse: "tool_result",
  PostToolUseFailure: "tool_result",
  Stop: "agent_end",
  SessionStart: "session_start",
  SessionEnd: "session_shutdown",
  PreCompact: "session_before_compact",
  PostCompact: "session_compact",
};

const NATIVE = new Set<NormalizedEvent["type"]>([
  "input",
  "tool_call",
  "tool_result",
  "context",
  "agent_end",
  "session_start",
  "session_shutdown",
  "session_before_compact",
  "session_compact",
]);

export function normalizeEvent(sourceType: string, payload: Record<string, unknown>): NormalizedEvent {
  const type = ALIASES[sourceType] ?? (NATIVE.has(sourceType as NormalizedEvent["type"])
    ? sourceType as NormalizedEvent["type"]
    : undefined);
  if (!type) throw new Error(`Unsupported Hook Host event: ${sourceType}`);

  const input = normalizeInput(type, payload);

  return {
    type,
    sourceType,
    toolName: stringValue(payload.toolName) ?? stringValue(payload.tool_name),
    toolCallId: stringValue(payload.toolCallId) ?? stringValue(payload.toolUseId) ?? stringValue(payload.tool_use_id),
    input,
    isError: sourceType === "PostToolUseFailure" || payload.isError === true,
    payload,
  };
}

function normalizeInput(type: NormalizedEvent["type"], payload: Record<string, unknown>): Record<string, unknown> {
  if (type === "input") {
    return cloneDeep({
      text: stringValue(payload.text) ?? "",
      ...(Array.isArray(payload.images) ? { images: payload.images } : {}),
    });
  }
  if (type === "context") {
    return cloneDeep({ messages: Array.isArray(payload.messages) ? payload.messages : [] });
  }
  const rawInput = payload.input ?? payload.toolInput ?? {};
  return rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? cloneDeep(rawInput as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
