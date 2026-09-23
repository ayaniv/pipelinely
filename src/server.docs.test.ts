import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// Proves GET /api/docs — tech-design-pipelinely-docs.md §3: renders
// docs/user-guide.md through the same renderMarkdownToHtml the Plan tab's
// GET /tech-design/:slug already uses, 404s on a missing file, 500s on any
// other read failure, and both are logged. DOCS_GUIDE_PATH (read live per
// request, an env override mirroring taskParser.ts's reposDir()/
// worktreesDir()) points the route at a fixture instead of mutating the
// real repo file, which would race docsGuide.test.ts reading it in a
// concurrent worker.

let handle: TestServerHandle
let baseUrl: string
let fixtureDir: string

beforeAll(async () => {
  handle = await startTestServer()
  baseUrl = `http://127.0.0.1:${handle.boundPort}`
})

afterAll(async () => {
  await stopTestServer(handle, ['DOCS_GUIDE_PATH'])
})

beforeEach(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-docs-guide-'))
})

afterEach(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true })
  delete process.env.DOCS_GUIDE_PATH
})

describe('GET /api/docs', () => {
  it('200: renders the guide file through renderMarkdownToHtml', async () => {
    const guidePath = path.join(fixtureDir, 'happy-path.md')
    await fs.writeFile(guidePath, '# Guide\n\n## Getting started\n\nInstall it.\n')
    process.env.DOCS_GUIDE_PATH = guidePath

    const res = await fetch(`${baseUrl}/api/docs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      html: '<h1>Guide</h1>\n<h2>Getting started</h2>\n<p>Install it.</p>',
    })
  })

  it('200: the response is escaped HTML, not raw Markdown', async () => {
    const guidePath = path.join(fixtureDir, 'escaping.md')
    await fs.writeFile(guidePath, '# <script>alert(1)</script>\n')
    process.env.DOCS_GUIDE_PATH = guidePath

    const res = await fetch(`${baseUrl}/api/docs`)
    expect(res.status).toBe(200)
    const { html } = await res.json()
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('404: a missing guide file (a checkout that predates it, or an unpublished guide)', async () => {
    process.env.DOCS_GUIDE_PATH = path.join(fixtureDir, 'does-not-exist.md')

    const res = await fetch(`${baseUrl}/api/docs`)
    expect(res.status).toBe(404)
  })

  it('500: a read error that is not a missing file (e.g. a directory in its place), and logs it', async () => {
    const dirInPlaceOfFile = path.join(fixtureDir, 'a-directory')
    await fs.mkdir(dirInPlaceOfFile)
    process.env.DOCS_GUIDE_PATH = dirInPlaceOfFile
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const res = await fetch(`${baseUrl}/api/docs`)
      expect(res.status).toBe(500)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
