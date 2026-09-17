import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type ExtractPaths = (event: unknown) => { paths: readonly { path: string }[] } | undefined;

describe("bundled pi-lsp post-edit path matching", () => {
  it("accepts only exact paths or aliases of the same existing file", async () => {
    const modulePath = "@ian-pascoe/pi-lsp/src/" + "lsp-post-edit-diagnostics.js";
    const { extractPostEditDiagnosticPaths } = await import(modulePath) as {
      extractPostEditDiagnosticPaths: ExtractPaths;
    };
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-lsp-paths-"));
    try {
      const actualDir = join(dir, "actual");
      const aliasDir = join(dir, "alias");
      await mkdir(actualDir);
      await symlink(actualDir, aliasDir, "dir");
      const actualPath = join(actualDir, "example.ts");
      const aliasPath = join(aliasDir, "example.ts");
      const unrelatedPath = join(actualDir, "unrelated.ts");
      await writeFile(actualPath, "export {};\n");
      await writeFile(unrelatedPath, "export {};\n");

      const event = (manifestPath: string, changedPath: string) => ({
        toolName: "lsp",
        input: { operation: "apply", mutation_manifest: [{ operation: "modify", path: manifestPath }] },
        details: { kind: "workspace_edit_apply", state: "applied", changed_paths: [changedPath] },
        isError: false,
      });

      expect(extractPostEditDiagnosticPaths(event(actualPath, aliasPath))?.paths).toEqual([
        { path: actualPath },
      ]);
      expect(extractPostEditDiagnosticPaths(event(actualPath, unrelatedPath))?.paths).toEqual([]);

      const missingPath = join(actualDir, "missing.ts");
      expect(extractPostEditDiagnosticPaths(event(missingPath, join(aliasDir, "other-missing.ts")))?.paths).toEqual([]);
      expect(extractPostEditDiagnosticPaths(event(missingPath, missingPath))?.paths).toEqual([
        { path: missingPath },
      ]);
      expect(extractPostEditDiagnosticPaths({
        toolName: "lsp",
        input: { operation: "apply", mutation_manifest: [{ operation: "delete", path: actualPath }] },
        details: { kind: "workspace_edit_apply", state: "applied", changed_paths: [actualPath] },
        isError: false,
      })?.paths).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
