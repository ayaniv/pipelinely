import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// TAB_NAMES (public/index.html) and the board tabs' shell routes
// (src/server.ts) are two records of the same list that cannot import from
// each other. Add a tab the client way only, and it works in-session and
// 404s on a cold load or a shared link — this test catches that drift in
// the same diff that creates the second source of truth, rather than in
// production. Extracted from the real files rather than hand-copied, same
// convention as setHtmlIfChanged.test.ts/rates.test.ts.
let TAB_NAMES: string[]
let DEFAULT_TAB: string
let serverSource: string

beforeAll(async () => {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

  const indexHtmlSource = await fs.readFile(path.join(rootDir, 'public', 'index.html'), 'utf-8')
  const tabNamesMatch = indexHtmlSource.match(/const TAB_NAMES = (\[[^\]]*\])/)
  if (!tabNamesMatch) throw new Error('TAB_NAMES not found in public/index.html — extraction regex is stale')
  const defaultTabMatch = indexHtmlSource.match(/const DEFAULT_TAB = '([^']+)'/)
  if (!defaultTabMatch) throw new Error('DEFAULT_TAB not found in public/index.html — extraction regex is stale')

  // eslint-disable-next-line no-new-func -- deliberate: evaluating the real,
  // extracted source rather than a hand-copied reimplementation.
  TAB_NAMES = new Function(`return ${tabNamesMatch[1]}`)()
  DEFAULT_TAB = defaultTabMatch[1]

  serverSource = await fs.readFile(path.join(rootDir, 'src', 'server.ts'), 'utf-8')
})

describe('tab routes stay in sync with TAB_NAMES', () => {
  it('every non-default tab has a matching shell route in src/server.ts', () => {
    for (const tab of TAB_NAMES) {
      if (tab === DEFAULT_TAB) continue
      const hasRoute = new RegExp(`app\\.get\\('\\/${tab}',`).test(serverSource)
      expect(hasRoute, `expected src/server.ts to have a GET /${tab} route for TAB_NAMES entry '${tab}'`).toBe(true)
    }
  })

  it('the default tab has no route of its own — it lives at bare \'/\'', () => {
    const hasRoute = new RegExp(`app\\.get\\('\\/${DEFAULT_TAB}',`).test(serverSource)
    expect(hasRoute, `expected src/server.ts to NOT have a dedicated /${DEFAULT_TAB} route — it would create a second URL for the default tab with no redirect between them`).toBe(false)
  })
})
