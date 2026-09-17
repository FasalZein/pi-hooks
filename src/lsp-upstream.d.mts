/** Narrow boundary for the patched source-only package; verified by packed integration tests. */
import type { ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
export const PI_HOOKS_SETTINGS_API: number;
export function createPiLspExtension(effects: {
  getAgentDirectory(): string;
  readSettings(context: ExtensionContext): Promise<{ getGlobalSettings(): Record<string, unknown>; getProjectSettings(): Record<string, unknown> }>;
  writeEnablement(input: { scope: 'global' | 'project'; serverId: string; enabled: boolean; agentDirectory: string; cwd: string; projectTrusted: boolean }): Promise<void>;
  persistenceScopes?: readonly ('global' | 'project')[];
}): ExtensionFactory;
