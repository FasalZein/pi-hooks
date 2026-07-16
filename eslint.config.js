import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["src/**/*.ts", "test/**/*.ts"],
  extends: [tseslint.configs.recommended],
});
