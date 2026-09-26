import { defineConfig } from "vitest/config";

// End-to-end checks against the real Claude Code and Codex CLIs, when installed.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
  },
});
