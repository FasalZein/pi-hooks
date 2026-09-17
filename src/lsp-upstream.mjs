// The upstream package publishes TypeScript source, not a typed library entry.
// Pi's loader resolves it; the adjacent declaration describes this checked patch boundary.
export { createPiLspExtension, PI_HOOKS_SETTINGS_API } from '@ian-pascoe/pi-lsp/src/pi-lsp-extension.ts';
