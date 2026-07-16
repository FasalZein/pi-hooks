import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditRecord } from "./types.js";

const REDACTED = "[REDACTED]";
const MAX_RETAINED = 256;

export interface AuditHealth {
  health: "healthy" | "degraded";
  lastFailure?: string;
  retained: number;
}

export class AuditLog {
  private readonly records: AuditRecord[] = [];
  private failure?: string;

  constructor(private readonly path?: string, private readonly includeAllows = false) {}

  status(): AuditHealth {
    return {
      health: this.failure ? "degraded" : "healthy",
      ...(this.failure ? { lastFailure: this.failure } : {}),
      retained: this.records.length,
    };
  }

  async record(record: AuditRecord): Promise<void> {
    if (record.decision === "allow" && !this.includeAllows) return;
    const safe = minimize(record);
    this.records.push(safe);
    if (this.records.length > MAX_RETAINED) this.records.splice(0, this.records.length - MAX_RETAINED);
    if (!this.path) return;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(safe)}\n`, "utf8");
    } catch (error) {
      this.failure = `Audit persistence failed (${errorCode(error)})`;
    }
  }
}

function minimize(record: AuditRecord): AuditRecord {
  return {
    timestamp: record.timestamp,
    ...(record.sessionId ? { sessionId: hash(record.sessionId) } : {}),
    moduleId: sanitizeText(record.moduleId, 64),
    eventType: record.eventType,
    phase: record.phase,
    decision: record.decision,
    ...(record.reason ? { reason: REDACTED } : {}),
    ...(record.inputSummary && typeof record.inputSummary === "object" && !Array.isArray(record.inputSummary)
      ? { inputSummary: summarizeInput(record.inputSummary as Record<string, unknown>) }
      : {}),
  };
}

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const types: Record<string, number> = {};
  for (const value of Object.values(input).slice(0, 64)) {
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    types[type] = (types[type] ?? 0) + 1;
  }
  return {
    fieldCount: Object.keys(input).length,
    types,
    truncated: Object.keys(input).length > 64,
  };
}

function sanitizeText(value: string, limit: number): string {
  const safe = value
    .replace(/\bhttps?:\/\/\S+/gi, "[URL REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(token|secret|password|passphrase|authorization|api[-_]?key|private[-_]?key|credential|cookie)\s*[:=]\s*[^\s,;]+/gi, `$1=${REDACTED}`);
  return safe.length > limit ? `${safe.slice(0, limit - 1)}…` : safe;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "UNKNOWN";
}
