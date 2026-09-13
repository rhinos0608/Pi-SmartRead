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
    files: ["test/**/*.ts"],
    rules: {
      "no-console": "off",
    },
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
      "no-console": ["warn", { "allow": ["warn", "error"] }],
      "prefer-const": "error",
      "no-var": "error",
      "eqeqeq": ["error", "smart"],
      "no-throw-literal": "error",
      "prefer-promise-reject-errors": "error",

      // P0 guardrails — warnings so existing debt does not fail
      "complexity": ["warn", 15],
      "max-depth": ["warn", 4],
      "max-params": ["warn", 5],
      "max-lines-per-function": ["warn", { "max": 100, "skipBlankLines": true, "skipComments": true, "IIFEs": true }],
    },
  },
  {
    // P0 guardrails as errors for the 22 extracted modules only
    files: [
      "src/canonical-path.ts",
      "src/context-graph-build.ts",
      "src/extension-lifecycle.ts",
      "src/extension-registration.ts",
      "src/extension-result-pipeline.ts",
      "src/grep-cascade.ts",
      "src/grep-structural-executor.ts",
      "src/hook-enrich.ts",
      "src/inspect-budget.ts",
      "src/inspect-file-core.ts",
      "src/inspect-file-sections.ts",
      "src/lsp-call-hierarchy-adapter.ts",
      "src/lsp-navigation-adapter.ts",
      "src/lsp-server-operation.ts",
      "src/read-many-evidence.ts",
      "src/read-many-plan.ts",
      "src/read-many-reader.ts",
      "src/rerank-colbert.ts",
      "src/rerank-external.ts",
      "src/rerank-structural.ts",
      "src/shared-context-graph.ts",
      "src/test-linkage.ts",
    ],
    rules: {
      "complexity": ["error", 15],
      "max-depth": ["error", 4],
      "max-params": ["error", 5],
      "max-lines-per-function": ["error", { "max": 100, "skipBlankLines": true, "skipComments": true, "IIFEs": true }],
    },
  },
);
