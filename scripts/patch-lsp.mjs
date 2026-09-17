import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const base = new URL('../', import.meta.url);
const patch = JSON.parse(readFileSync(new URL('scripts/lsp-settings-patch.json', base), 'utf8'));
const dependency = new URL('node_modules/@ian-pascoe/pi-lsp/', base);
const manifest = JSON.parse(readFileSync(new URL('package.json', dependency), 'utf8'));
if (manifest.version !== patch.version) throw new Error('pi-hooks LSP patch: unsupported dependency version');
const hash = (text) => createHash('sha256').update(text).digest('hex');
for (const file of patch.files) {
  const path = new URL(file.path, dependency);
  const original = readFileSync(path, 'utf8');
  if (hash(original) === file.patchedSha256) continue;
  if (hash(original) !== file.originalSha256) throw new Error(`pi-hooks LSP patch: dependency source changed at ${file.path}; refusing to overwrite it`);
  let output = original;
  for (const [before, after] of file.replacements) {
    if (output.split(before).length !== 2) throw new Error(`pi-hooks LSP patch: ambiguous patch location in ${file.path}`);
    output = output.replace(before, after);
  }
  output += file.suffix;
  if (hash(output) !== file.patchedSha256) throw new Error(`pi-hooks LSP patch: output checksum mismatch for ${file.path}`);
  writeFileSync(path, output);
}
