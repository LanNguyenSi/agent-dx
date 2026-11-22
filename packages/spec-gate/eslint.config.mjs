import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "test/fixtures/**", ".tmp-cli-*/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // TypeScript's own checker owns declaration tracking, so the
      // core no-undef rule from js.configs.recommended would only
      // produce false positives here (the standard typescript-eslint
      // guidance: https://typescript-eslint.io/getting-started#-no-undef).
      "no-undef": "off",
    },
  },
];
