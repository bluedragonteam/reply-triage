import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Unit tests must never reach the real API, even if a key is exported in the shell.
    env: { ANTHROPIC_API_KEY: "" },
  },
});
