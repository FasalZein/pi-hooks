import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyEdits, modify } from 'jsonc-parser';
import { lockSync } from 'proper-lockfile';
import { loadGlobalConfig, parseGlobalConfig } from './config.js';

export async function readLspConfiguration(path: string) {
  const config = await loadGlobalConfig(path);
  const definitions = config.lsp?.servers ?? {};
  const servers: Record<string, unknown> = {};
  const enablement = { ...config.lsp?.enablement };
  for (const [id, definition] of Object.entries(definitions)) {
    if (definition === null) continue;
    const { enabled, ...server } = definition;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      servers[id] = definition;
      continue;
    }
    if (enabled !== undefined && enablement[id] === undefined) enablement[id] = enabled;
    servers[id] = server;
  }
  return {
    getGlobalSettings: () => ({ lsp: { ...config.lsp, servers, enablement } }),
    getProjectSettings: () => ({}), // One global product file; no executable project overlays.
  };
}

/** Lock, re-read, validate, then edit only the named boolean. Never hold a lock over await. */
export async function writeLspEnablement(path: string, input: { scope: 'global' | 'project'; serverId: string; enabled: boolean }): Promise<void> {
  if (input.scope !== 'global') throw new Error('pi-hooks uses global pi-hooks.jsonc. Use --global or a session-scoped LSP toggle.');
  if (!input.serverId.trim()) throw new Error('LSP server id must not be empty');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const target = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(path) : path;
  const release = lockSync(target, { realpath: false });
  const temporary = join(dirname(target), `.pi-hooks-${randomUUID()}.tmp`);
  try {
    const exists = lstatSync(target, { throwIfNoEntry: false });
    const text = exists ? readFileSync(target, 'utf8') : '{\n  "schemaVersion": 2\n}\n';
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const source = text.slice(bom.length);
    parseGlobalConfig(source);
    const next = applyEdits(source, modify(source, ['lsp', 'enablement', input.serverId], input.enabled, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    parseGlobalConfig(next);
    if (next === source) return;
    writeFileSync(temporary, bom + next, { flag: 'wx', mode: exists ? statSync(target).mode & 0o777 : 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
    release();
  }
}
