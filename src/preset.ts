import { createPiHooksExtension } from "./adapter.js";
import { policyEngineProvider } from "./policy-engine.js";
import { actionEngineProvider } from "./action-engine.js";

/** The installable composition. The package-root default stays a Bare Host. */
export const piHooksPreset = createPiHooksExtension({
  preset: "pi-hooks",
  providers: [policyEngineProvider, actionEngineProvider],
  providerDefaults: [
    { id: "policy-engine", config: { rules: [] } },
    { id: "action-engine", required: false, config: { recipes: [] } },
  ],
});

export default piHooksPreset;
