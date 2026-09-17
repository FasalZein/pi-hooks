import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHookHost, policyEngineProvider, normalizeEvent } from "../src/index.js";
import { resolvePresetConfig } from "../src/preset-config.js";
import { resolveNamedEntries } from "../src/named-entries.js";
import legacyParity from "./fixtures/legacy-command-parity.json" with { type: "json" };

async function withConfig(config: Record<string, unknown> | undefined, run: (host: Awaited<ReturnType<typeof createHookHost>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-hooks-defaults-'));
  try {
    const configPath = join(dir, 'pi-hooks.jsonc');
    if (config) await writeFile(configPath, JSON.stringify({ schemaVersion: 2, ...config }));
    await run(await createHookHost({ configPath, configure: resolvePresetConfig, providers: [policyEngineProvider] }));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const dispatch = (host: Awaited<ReturnType<typeof createHookHost>>, command: string) => host.dispatch(
  normalizeEvent('tool_call', { toolName: 'bash', toolCallId: command, input: { command } }), { cwd: process.cwd(), hasUI: false });

describe('configurable Preset defaults', () => {
  it('protects configured and formerly hardcoded danger with no configuration file', async () => {
    await withConfig(undefined, async (host) => {
      expect(host.status().activation).toBe('active');
      for (const command of ['rm file', 'sudo true', '/usr/bin/sudo true', 'chmod 777 file', 'chmod a+rwx file', 'dd if=x of=/dev/disk', 'mkfs.ext4 disk', 'fdisk', 'parted disk', 'format disk', 'shutdown', 'reboot', 'halt', 'poweroff', 'init 0']) {
        expect(await dispatch(host, command)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('Remedy:') });
      }
      for (const command of ['npm run format', 'echo halt', 'git status', 'npm run verify']) expect((await dispatch(host, command)).decision).toBe('allow');
    });
  });
  it('matches recorded outputs from the pinned legacy classifier fixture', async () => {
    expect(legacyParity.reference).toMatchObject({ version: '1.0.5', commit: '5590a3bacbbdd055fb49d2ca031abe2c9f3e6c25', generatedBy: 'classifyCommand(command, explicitFixture)' });
    expect(legacyParity.fixture.overrides.dangerous).toHaveLength(28);
    await withConfig(undefined, async (host) => {
      for (const sample of legacyParity.cases) {
        expect((await dispatch(host, sample.command)).decision, sample.command).toBe(sample.dangerous ? 'deny' : 'allow');
      }
    });
  });
  it('disables or overrides a named built-in without deleting its siblings', async () => {
    await withConfig({ rules: [{ id: 'danger-01', enabled: false }, { id: 'danger-sudo', decision: 'allow' }] }, async (host) => {
      for (const command of ['rm file', '  rm file', '/opt/tools/rm -rf disposable']) expect((await dispatch(host, command)).decision).toBe('allow');
      for (const command of ['sudo true', '\\sudo true']) expect((await dispatch(host, command)).decision).toBe('allow');
      expect((await dispatch(host, 'mkfs.ext4 disk')).decision).toBe('deny');
    });
  });
  it('adds a new named rule and rejects duplicate ids', async () => {
    const rule = { id: 'build', match: { tool: 'bash', input: { command: { glob: 'npm run build' } } }, decision: 'deny', scope: 'build', remedy: 'use tests' };
    await withConfig({ rules: [rule] }, async (host) => expect(await dispatch(host, 'npm run build')).toMatchObject({ decision: 'deny', reason: expect.stringContaining('build') }));
    await withConfig({ rules: [rule, rule] }, async (host) => expect(host.status()).toMatchObject({ activation: 'inactive', configuration: { lastFailure: expect.stringContaining('Duplicate') } }));
  });
  it('resolves named Recipe entries without mutating defaults', () => {
    const defaults = [{ id: 'first', command: 'one' }, { id: 'second', command: 'two' }];
    expect(resolveNamedEntries(defaults, [{ id: 'first', command: 'changed' }, { id: 'second', enabled: false }, { id: 'new', command: 'three' }])).toEqual([{ id: 'first', command: 'changed' }, { id: 'new', command: 'three' }]);
    expect(defaults[0].command).toBe('one');
  });
});
