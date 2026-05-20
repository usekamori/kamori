import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@kamori/core": path.resolve("./packages/core/src/index.ts"),
      "@kamori/mcp/tools": path.resolve("./packages/mcp/src/tools.ts"),
    },
  },
});
//# sourceMappingURL=vitest.config.js.map
