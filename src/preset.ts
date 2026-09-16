import { createPiHooksExtension } from "./adapter.js";
import { policyEngineProvider } from "./policy-engine.js";

/** The installable composition. The package-root default stays a Bare Host. */
export const piHooksPreset = createPiHooksExtension({
  preset: "pi-hooks",
  providers: [policyEngineProvider],
  providerDefaults: [{ id: "policy-engine", config: { rules: [] } }],
});

export default piHooksPreset;
