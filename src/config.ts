import { readFile } from "node:fs/promises";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { Value } from "typebox/value";

export interface GlobalConfig {
  schemaVersion: 1;
  modules: Array<{ id: string; enabled?: boolean }>;
  audit?: { path?: string; includeAllows?: boolean };
}

export async function loadGlobalConfig(path: string): Promise<GlobalConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read trusted global configuration ${path}: ${message(error)}`);
  }

  const parseErrors: ParseError[] = [];
  const value = parse(text, parseErrors, { allowTrailingComma: true, disallowComments: false });
  if (parseErrors.length > 0) {
    throw new Error(`Invalid JSONC: ${parseErrors.map((error) => printParseErrorCode(error.error)).join(", ")}`);
  }
  const schema = JSON.parse(await readFile(new URL("../schema/pi-hooks.global.schema.json", import.meta.url), "utf8"));
  if (!Value.Check(schema, value)) {
    const errors = [...Value.Errors(schema, value)].map((error) => error.message);
    throw new Error(`Schema validation failed: ${errors.join("; ")}`);
  }
  return value as GlobalConfig;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
