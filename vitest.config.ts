import { defineConfig } from "vitest/config";

// Unit + integration suites live next to the code as *.test.ts. They run fully
// offline: the agent loop is driven by a scripted LLM client (no network, no
// API key), and execute_analyst_query hits a real in-process DuckDB built from
// the local fixture.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
