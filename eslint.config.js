import tseslint from "typescript-eslint";
import tsParser from "@typescript-eslint/parser";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".pi-smartread.embeddings.cache/**",
      ".pi-smartread.tags.cache/**",
      "**/dump.ts",
      "dist/**",
      "build/**",
      "coverage/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      // Already covered by TypeScript strict checks
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",

      // Additional quality rules
      "no-console": "warn",
      "prefer-const": "error",
      "no-var": "error",
      "eqeqeq": ["error", "smart"],
      "no-throw-literal": "error",
      "prefer-promise-reject-errors": "error",
    },
  },
);
