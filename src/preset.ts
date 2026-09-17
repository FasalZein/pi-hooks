import { createPiHooksExtension } from "./adapter.js";
import { policyEngineProvider } from "./policy-engine.js";
import { actionEngineProvider } from "./action-engine.js";
import { resolvePresetConfig } from "./preset-config.js";

/** The installable composition. The package-root default stays a Bare Host. */
export const piHooksPreset = createPiHooksExtension({
  preset: "pi-hooks",
  providers: [policyEngineProvider, actionEngineProvider],
  configure: resolvePresetConfig,
});

export default piHooksPreset;
