import { cloneDeep } from "./isolate.js";
import { EVENT_TYPES, type HookEventType, type HookModule, type NormalizedEvent } from "./types.js";

/** Rejection remedies only. No external name is normalized into a native event. */
const NATIVE_REMEDIES: Record<string, HookEventType> = {
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

export function assertNativeEvent(value: string): asserts value is HookEventType {
  if ((EVENT_TYPES as readonly string[]).includes(value)) return;
  const remedy = NATIVE_REMEDIES[value];
  throw new Error(`Unsupported Hook Host event: ${value}. ${remedy ? `Use native event ${remedy}` : `Use a native event: ${EVENT_TYPES.join(", ")}`}`);
}

export function validateModuleEvents(module: HookModule): void {
  for (const key of Object.keys(module)) {
    if (["id", "requires", "before", "after"].includes(key)) continue;
    assertNativeEvent(key);
  }
}

export function normalizeEvent(sourceType: string, payload: Record<string, unknown>): NormalizedEvent {
  assertNativeEvent(sourceType);
  const type = sourceType;

  const input = normalizeInput(type, payload);

  return {
    type,
    sourceType,
    toolName: stringValue(payload.toolName) ?? stringValue(payload.tool_name),
    toolCallId: stringValue(payload.toolCallId) ?? stringValue(payload.toolUseId) ?? stringValue(payload.tool_use_id),
    input,
    isError: payload.isError === true,
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
