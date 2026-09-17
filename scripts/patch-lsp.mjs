import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const base = new URL('../', import.meta.url);
const patch = JSON.parse(readFileSync(new URL('scripts/lsp-settings-patch.json', base), 'utf8'));
const dependency = new URL('node_modules/@ian-pascoe/pi-lsp/', base);
const manifest = JSON.parse(readFileSync(new URL('package.json', dependency), 'utf8'));
if (manifest.version !== patch.version) throw new Error('pi-hooks LSP patch: unsupported dependency version');
const path = new URL('src/pi-lsp-extension.ts', dependency);
const original = readFileSync(path, 'utf8');
const hash = (text) => createHash('sha256').update(text).digest('hex');
if (hash(original) !== patch.patchedSha256) {
  if (hash(original) !== patch.originalSha256) throw new Error('pi-hooks LSP patch: dependency source changed; refusing to overwrite it');
  let output = original;
  for (const [before, after] of patch.replacements) {
    if (output.split(before).length !== 2) throw new Error('pi-hooks LSP patch: ambiguous patch location');
    output = output.replace(before, after);
  }
  output += patch.suffix;
  if (hash(output) !== patch.patchedSha256) throw new Error('pi-hooks LSP patch: output checksum mismatch');
  writeFileSync(path, output);
}
