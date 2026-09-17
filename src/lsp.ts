import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { createPiLspExtension, PI_HOOKS_SETTINGS_API } from './lsp-upstream.mjs';
import { readLspConfiguration, writeLspEnablement } from './lsp-config.js';

if (PI_HOOKS_SETTINGS_API !== 1) throw new Error('pi-hooks LSP adapter requires the checked dependency patch. Run npm run prepare:lsp.');

export default createPiLspExtension({
  getAgentDirectory: getAgentDir,
  readSettings: () => readLspConfiguration(join(getAgentDir(), 'pi-hooks.jsonc')),
  writeEnablement: (input) => writeLspEnablement(join(getAgentDir(), 'pi-hooks.jsonc'), input),
});
