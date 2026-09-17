import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type PatchFile = {
  path: string;
  replacements: Array<[string, string]>;
  suffix: string;
  originalSha256: string;
  patchedSha256: string;
};

describe("checked pi-lsp dependency patch", () => {
  it("applies every checked file once, remains idempotent, and refuses changed input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hooks-lsp-patch-"));
    try {
      const patch = JSON.parse(await readFile(join(root, "scripts/lsp-settings-patch.json"), "utf8")) as { version: string; files: PatchFile[] };
      await mkdir(join(dir, "scripts"), { recursive: true });
      await cp(join(root, "scripts/patch-lsp.mjs"), join(dir, "scripts/patch-lsp.mjs"));
      await cp(join(root, "scripts/lsp-settings-patch.json"), join(dir, "scripts/lsp-settings-patch.json"));
      const dependency = join(dir, "node_modules/@ian-pascoe/pi-lsp");
      await mkdir(dependency, { recursive: true });
      await writeFile(join(dependency, "package.json"), JSON.stringify({ version: patch.version }));

      for (const file of patch.files) {
        const installed = await readFile(join(root, "node_modules/@ian-pascoe/pi-lsp", file.path), "utf8");
        let original = file.suffix ? installed.slice(0, -file.suffix.length) : installed;
        for (const [before, after] of [...file.replacements].reverse()) {
          expect(original.split(after)).toHaveLength(2);
          original = original.replace(after, before);
        }
        expect(sha256(original)).toBe(file.originalSha256);
        const target = join(dependency, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, original);
      }

      await exec(process.execPath, [join(dir, "scripts/patch-lsp.mjs")], { cwd: dir });
      const once = new Map<string, string>();
      for (const file of patch.files) {
        const output = await readFile(join(dependency, file.path), "utf8");
        expect(sha256(output)).toBe(file.patchedSha256);
        once.set(file.path, output);
      }
      await exec(process.execPath, [join(dir, "scripts/patch-lsp.mjs")], { cwd: dir });
      for (const file of patch.files) expect(await readFile(join(dependency, file.path), "utf8")).toBe(once.get(file.path));

      const changed = patch.files[1]!;
      await writeFile(join(dependency, changed.path), `${once.get(changed.path)}\nchanged`);
      await expect(exec(process.execPath, [join(dir, "scripts/patch-lsp.mjs")], { cwd: dir })).rejects.toMatchObject({
        stderr: expect.stringContaining(`dependency source changed at ${changed.path}`),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
