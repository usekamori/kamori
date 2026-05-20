import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        // Test files
        "packages/*/src/**/*.test.ts",
        "packages/*/src/**/__tests__/**",
        // Entrypoints — thin wrappers with no logic to unit-test
        "packages/ingest/src/ingest.ts",
        "packages/mcp/src/mcp.ts",
        "packages/mcp/src/start-mcp.ts",
        // CLI scaffolder — tested via e2e, not unit tests
        "packages/create-kamori/**",
        // Pure TypeScript interface / type-only files — no executable lines
        "packages/core/src/adapters/db-adapter.ts",
        "packages/core/src/adapters/ingest-plugins.ts",
        "packages/core/src/adapters/email-adapter.ts",
        // Re-export barrels
        "packages/*/src/index.ts",
        "packages/core/src/adapters/index.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      "/core": path.resolve("./packages/core/src/index.ts"),
      "@usekamori/core": path.resolve("./packages/core/src/index.ts"),
      "@usekamori/ingest": path.resolve("./packages/ingest/src/index.ts"),
      "@usekamori/mcp": path.resolve("./packages/mcp/src/mcp.ts"),
      "@usekamori/sdk": path.resolve("./packages/sdk/src/index.ts"),
      "/mcp/tools": path.resolve("./packages/mcp/src/tools.ts"),
      "/sdk": path.resolve("./packages/sdk/src/index.ts"),
    },
  },
});
