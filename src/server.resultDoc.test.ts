import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// GET /result-doc/:slug — the lazily-fetched half of a research task's
// deliverable. The snapshot carries only metadata (see Task.resultDoc); this
// route is where the markdown itself comes from, under the same rule as
// GET /tech-design/:slug: only a slug already in currentTasks can be named.
// Fixtures are written before main() starts, since this suite's currentTasks is
// only ever populated by main()'s one initial refreshTasks().

let handle: TestServerHandle
let baseUrl: string
let outsideDir: string

const AUDIT_MARKDOWN = '# The audit\n\nSENTINEL-MARKDOWN-BODY-9f3a\n'

async function writeTask(tasksDir: string, slug: string, taskMdExtra: string, files: Record<string, string> = {}): Promise<void> {
  const dir = path.join(tasksDir, slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'STATUS'), 'working\n')
  await fs.writeFile(path.join(dir, 'TASK.md'), `# ${slug}\n\n## Workspace\n- Repo: r\n- Branch: b\n\n${taskMdExtra}`)
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content)
}

beforeAll(async () => {
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-result-doc-outside-'))
  await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'SENTINEL-SECRET-77c1')
  handle = await startTestServer({}, async (tasksDir) => {
    await writeTask(tasksDir, 'with-audit', '## Mode: investigate\n', { 'AUDIT.md': AUDIT_MARKDOWN })
    await writeTask(tasksDir, 'no-doc', '## Mode: investigate\n')
    await writeTask(tasksDir, 'implement-pr-notes', '## Mode: implement\n\n## Result\nPR: https://github.com/x/y/pull/1\n')
    await writeTask(tasksDir, 'symlinked', '## Mode: investigate\n')
    await fs.symlink(path.join(outsideDir, 'secret.txt'), path.join(tasksDir, 'symlinked', 'RESULT.md'))
  })
  baseUrl = `http://127.0.0.1:${handle.boundPort}`
})

afterAll(async () => {
  await stopTestServer(handle)
  await fs.rm(outsideDir, { recursive: true, force: true })
})

describe('GET /result-doc/:slug', () => {
  it('200: returns the document with its metadata', async () => {
    const res = await fetch(`${baseUrl}/result-doc/with-audit`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ file: 'AUDIT.md', markdown: AUDIT_MARKDOWN, isTruncated: false, totalBytes: Buffer.byteLength(AUDIT_MARKDOWN), mtimeMs: expect.any(Number) })
  })

  it('404: a task with no deliverable', async () => {
    expect((await fetch(`${baseUrl}/result-doc/no-doc`)).status).toBe(404)
  })

  it('404: an unknown slug', async () => {
    expect((await fetch(`${baseUrl}/result-doc/does-not-exist`)).status).toBe(404)
  })

  it('404: a path-traversal slug never reads outside the tasks dir', async () => {
    const res = await fetch(`${baseUrl}/result-doc/${encodeURIComponent(`../${path.basename(outsideDir)}`)}`)
    expect(res.status).toBe(404)
  })

  it('404: the "## Result" PR notes of an implement task are not a deliverable', async () => {
    expect((await fetch(`${baseUrl}/result-doc/implement-pr-notes`)).status).toBe(404)
  })

  it('404, and never the target\'s content: a RESULT.md symlinked to a file outside the task dir', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await fetch(`${baseUrl}/result-doc/symlinked`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('SENTINEL-SECRET-77c1')
  })
})

describe('the snapshot payload', () => {
  it('carries the deliverable\'s metadata but none of its markdown', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`)
    const raw = await res.text()
    expect(raw).not.toContain('SENTINEL-MARKDOWN-BODY-9f3a')
    const { tasks } = JSON.parse(raw) as { tasks: { slug: string; resultDoc?: unknown }[] }
    expect(tasks.find((t) => t.slug === 'with-audit')?.resultDoc).toEqual({ file: 'AUDIT.md', isTruncated: false, totalBytes: Buffer.byteLength(AUDIT_MARKDOWN), mtimeMs: expect.any(Number) })
    expect(tasks.find((t) => t.slug === 'no-doc')?.resultDoc).toBeNull()
  })
})
