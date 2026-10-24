import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// The designer's approval route and design QA's screenshot route, against a
// real server and throwaway tasks dir. appendTimelineLine is wrapped so one
// case can make the write fail and prove the route answers 500 and logs it.
const { appendTimelineLineMock } = vi.hoisted(() => ({ appendTimelineLineMock: vi.fn() }))

vi.mock('./taskParser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./taskParser.js')>()
  appendTimelineLineMock.mockImplementation(actual.appendTimelineLine)
  return { ...actual, appendTimelineLine: appendTimelineLineMock }
})

const AT_GATE = 'waiting: design QA done, ready for design approval'
// One gate task per case that mutates it: the server only learns of a STATUS
// rewritten on disk asynchronously, so a shared task would carry the previous
// case's decision into the next.
const AWAITING = 'ds-awaiting'
const APPROVE = 'ds-approve'
const REQUEST_CHANGES = 'ds-request-changes'
const WRITE_FAILS = 'ds-write-fails'
const NOT_AT_GATE = 'ds-qa-passed'
const DEV = 'dev-lookalike'

let handle: TestServerHandle
const url = (route: string) => `http://127.0.0.1:${handle.boundPort}${route}`
const taskFile = (slug: string, name: string) => path.join(handle.tmpDir, slug, name)
const post = (slug: string, body: unknown) =>
  fetch(url(`/design-approval/${slug}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function seedTask(tmpDir: string, slug: string, status: string, kind: string | null): Promise<void> {
  const dir = path.join(tmpDir, slug)
  await fs.mkdir(path.join(dir, 'design-qa'), { recursive: true })
  await fs.writeFile(path.join(dir, 'STATUS'), `${status}\n`)
  await fs.writeFile(path.join(dir, 'TIMELINE'), '2026-10-01T10:00:00Z design-qa 4 stories compared\n')
  await fs.writeFile(path.join(dir, 'TASK.md'), `# ${slug}\n\n## Workspace\n- Repo: fixture-repo\n- Branch: claude/${slug}\n`)
  if (kind) await fs.writeFile(path.join(dir, 'KIND'), `${kind}\n`)
  await fs.writeFile(path.join(dir, 'design-qa', 'primary-light.png'), 'png-bytes')
}

beforeAll(async () => {
  handle = await startTestServer({}, async (tmpDir) => {
    for (const slug of [AWAITING, APPROVE, REQUEST_CHANGES, WRITE_FAILS]) await seedTask(tmpDir, slug, AT_GATE, 'ds')
    await seedTask(tmpDir, NOT_AT_GATE, 'waiting: QA passed, ready to merge', 'ds')
    await seedTask(tmpDir, DEV, AT_GATE, null)
  })
})

afterAll(async () => {
  await stopTestServer(handle)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /design-approval/:slug', () => {
  it('approve records the approval and hands the task to merge', async () => {
    const res = await post(APPROVE, { decision: 'approve' })

    expect(res.status).toBe(200)
    expect(await fs.readFile(taskFile(APPROVE, 'STATUS'), 'utf-8')).toBe('waiting: design approved, ready to merge\n')
    expect(await fs.readFile(taskFile(APPROVE, 'TIMELINE'), 'utf-8')).toMatch(/Z design-approval approved\n$/)
  })

  it('request-changes writes DESIGN_FEEDBACK.md and hands off to design fixes', async () => {
    const res = await post(REQUEST_CHANGES, { decision: 'request-changes', notes: 'Dark radius should be 8px' })

    expect(res.status).toBe(200)
    expect(await fs.readFile(taskFile(REQUEST_CHANGES, 'DESIGN_FEEDBACK.md'), 'utf-8')).toBe('Dark radius should be 8px\n')
    expect(await fs.readFile(taskFile(REQUEST_CHANGES, 'STATUS'), 'utf-8')).toContain('triage and dispatch design-fixes')
  })

  it('answers 409 and changes nothing for a ds task that is not waiting at the gate', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(NOT_AT_GATE, { decision: 'approve' })

    expect(res.status).toBe(409)
    expect(await fs.readFile(taskFile(NOT_AT_GATE, 'STATUS'), 'utf-8')).toBe('waiting: QA passed, ready to merge\n')
  })

  it('answers 409 for a dev task whose STATUS happens to read like the gate', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await post(DEV, { decision: 'approve' })).status).toBe(409)
  })

  it('answers 400 for blank change notes and writes nothing', async () => {
    const res = await post(AWAITING, { decision: 'request-changes', notes: '   ' })

    expect(res.status).toBe(400)
    expect(await fs.readFile(taskFile(AWAITING, 'STATUS'), 'utf-8')).toBe(`${AT_GATE}\n`)
    await expect(fs.access(taskFile(AWAITING, 'DESIGN_FEEDBACK.md'))).rejects.toThrow()
  })

  it('answers 400 for an unknown decision', async () => {
    expect((await post(AWAITING, { decision: 'maybe' })).status).toBe(400)
  })

  it('answers 404 for an unknown task', async () => {
    expect((await post('no-such-task', { decision: 'approve' })).status).toBe(404)
  })

  it('answers 500 with the error, and logs it, when a write fails', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    appendTimelineLineMock.mockRejectedValueOnce(new Error('disk full'))

    const res = await post(WRITE_FAILS, { decision: 'approve' })

    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('disk full')
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Failed to record the design approval decision'))).toBe(true)
    expect(await fs.readFile(taskFile(WRITE_FAILS, 'STATUS'), 'utf-8')).toBe(`${AT_GATE}\n`)
  })
})

describe('GET /task-asset/:slug/design-qa/:file', () => {
  it('serves a screenshot with its image content type', async () => {
    const res = await fetch(url(`/task-asset/${AWAITING}/design-qa/primary-light.png`))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    expect(await res.text()).toBe('png-bytes')
  })

  it('refuses an encoded path traversal to a sibling file, and never leaks its content', async () => {
    const res = await fetch(url(`/task-asset/${AWAITING}/design-qa/..%2FSTATUS`))

    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('design approval')
  })

  it('refuses a traversing slug', async () => {
    const res = await fetch(url(`/task-asset/..%2F${AWAITING}/design-qa/primary-light.png`))
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('answers 404 for a screenshot that is not there', async () => {
    expect((await fetch(url(`/task-asset/${AWAITING}/design-qa/missing.png`))).status).toBe(404)
  })
})
