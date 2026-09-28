import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
      exclude: ["src/web/**", "src/server/main.ts", "src/cli.ts"],
    },
  },
});
