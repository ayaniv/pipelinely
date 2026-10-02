import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'root',
          environment: 'node',
          // e2e/**/*.spec.ts are Playwright specs (run via `npx playwright
          // test`), not vitest's — vitest's default include glob otherwise
          // picks them up and fails on Playwright's own test.describe().
          // Scoped to *.spec.ts only (not all of e2e/**) so e2e/fixtures/*.test.ts
          // — plain vitest unit tests for the fixture helpers themselves —
          // can still run. web/** is its own project below (jsdom).
          exclude: [...configDefaults.exclude, 'e2e/**/*.spec.ts', 'web/**'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/src/**/*.test.ts', 'web/src/**/*.test.tsx'],
          setupFiles: ['web/src/testSetup.ts'],
        },
      },
    ],
  },
})
