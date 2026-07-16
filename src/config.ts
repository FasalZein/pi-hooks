import { readFile } from "node:fs/promises";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";

/**
 * Trusted global configuration schema, built with Type from bare typebox,
 * validated through a compiled checker from typebox/compile, with errors
 * enumerated via typebox/value — pinning the exact Pi-managed loader-alias
 * path exercised by the clean packed install test (SLICE-0008 acceptance 9).
 * schema/pi-hooks.global.schema.json is the published editor copy of this schema.
 */
const GlobalConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  modules: Type.Array(Type.Object({
    id: Type.String({ minLength: 1 }),
    enabled: Type.Optional(Type.Boolean()),
    required: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false })),
  audit: Type.Optional(Type.Object({
    path: Type.Optional(Type.String({ minLength: 1 })),
    includeAllows: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const checkGlobalConfig = Compile(GlobalConfigSchema);

export interface GlobalConfig {
  schemaVersion: 1;
  modules: Array<{ id: string; enabled?: boolean; required?: boolean }>;
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
  if (!checkGlobalConfig.Check(value)) {
    const errors = [...Value.Errors(GlobalConfigSchema, value)].map((error) => `${error.instancePath || "/"}: ${error.message}`);
    throw new Error(`Schema validation failed: ${errors.join("; ")}`);
  }
  return value as GlobalConfig;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
