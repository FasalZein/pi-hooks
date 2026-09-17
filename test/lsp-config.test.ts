import { mkdtemp, readFile, rm, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lockSync } from "proper-lockfile";
import { readLspConfiguration, writeLspEnablement } from "../src/lsp-config.js";

async function withFile(run: (path: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-hooks-lsp-config-"));
  try { await run(join(dir, "pi-hooks.jsonc"), dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

describe('one authoritative LSP configuration', () => {
  it('uses no fallback Pi settings and supplies no untrusted project settings', async () => withFile(async (path, dir) => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ lsp: { servers: { wrong: { command: 'must-not-run' } } } }));
    const empty = await readLspConfiguration(path);
    expect(empty.getGlobalSettings()).toEqual({ lsp: { servers: {}, enablement: {} } });
    expect(empty.getProjectSettings()).toEqual({});
    await writeFile(path, '{ "schemaVersion": 2, "lsp": { "servers": { "custom": { "enabled": false, "command": "server" } } } }');
    const reader = await readLspConfiguration(path);
    expect(reader.getGlobalSettings()).toMatchObject({ lsp: { servers: { custom: { command: 'server' } }, enablement: { custom: false } } });
    expect(reader.getGlobalSettings().lsp.servers.custom).not.toHaveProperty('enabled');
  }));

  it('preserves comments, unrelated fields, permissions, symlinks, and repeated updates', async () => withFile(async (path, dir) => {
    const text = '\uFEFF{\n  // keep this explanation\n  "schemaVersion": 2,\n  "rendering": false, // plain UI\n  "rules": [{ "id": "danger-01", "enabled": false }],\n  "lsp": { "servers": { "custom": { "command": "server" } } },\n}\n';
    const real = join(dir, 'actual.jsonc');
    await writeFile(real, text, { mode: 0o640 });
    await symlink(real, path);
    await writeLspEnablement(path, { scope: 'global', serverId: 'custom', enabled: false });
    const updated = await readFile(path, 'utf8');
    expect(updated).toContain('// keep this explanation');
    expect(updated).toContain('// plain UI');
    expect(updated).toContain('"rules": [{ "id": "danger-01", "enabled": false }]');
    expect(updated.startsWith('\uFEFF')).toBe(true);
    expect((await stat(real)).mode & 0o777).toBe(0o640);
    await writeLspEnablement(path, { scope: 'global', serverId: 'custom', enabled: false });
    expect(await readFile(path, 'utf8')).toBe(updated);
    expect((await readLspConfiguration(path)).getGlobalSettings().lsp.enablement.custom).toBe(false);
    await writeLspEnablement(path, { scope: 'global', serverId: 'custom', enabled: true });
    expect((await readLspConfiguration(path)).getGlobalSettings().lsp.enablement.custom).toBe(true);
  }));

  it('refuses malformed files, competing writers, and project writes without replacing configuration', async () => withFile(async (path) => {
    await writeFile(path, '{ "schemaVersion": 2, "lsp": ');
    const invalid = await readFile(path, 'utf8');
    await expect(readLspConfiguration(path)).rejects.toThrow('Invalid JSONC');
    await expect(writeLspEnablement(path, { scope: 'global', serverId: 'custom', enabled: false })).rejects.toThrow('Invalid JSONC');
    expect(await readFile(path, 'utf8')).toBe(invalid);
    await writeFile(path, '{ "schemaVersion": 2 }');
    const release = lockSync(path, { realpath: false });
    try { await expect(writeLspEnablement(path, { scope: 'global', serverId: 'custom', enabled: false })).rejects.toMatchObject({ code: 'ELOCKED' }); }
    finally { release(); }
    expect(await readFile(path, 'utf8')).toBe('{ "schemaVersion": 2 }');
    await expect(writeLspEnablement(path, { scope: 'project', serverId: 'custom', enabled: false })).rejects.toThrow('Use --global');
  }));
});
