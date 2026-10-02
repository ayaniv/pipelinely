import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// vitest.config.ts's "web" project doesn't set test.globals, so
// @testing-library/react's own auto-cleanup (which only registers itself
// when it detects a global afterEach) never runs — every component test
// file would otherwise leak its rendered DOM into the next test in the same
// file. Registered here once for every web/src/**/*.test.tsx file.
afterEach(cleanup)
