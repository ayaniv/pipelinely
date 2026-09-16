import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    // e2e/**/*.spec.ts are Playwright specs (run via `npx playwright test`),
    // not vitest's — vitest's default include glob otherwise picks them up
    // and fails on Playwright's own test.describe(). Scoped to *.spec.ts
    // only (not all of e2e/**) so e2e/fixtures/*.test.ts — plain vitest
    // unit tests for the fixture helpers themselves — can still run.
    exclude: [...configDefaults.exclude, 'e2e/**/*.spec.ts'],
  },
})
