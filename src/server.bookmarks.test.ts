import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'
import { REMOTE_SESSION_COOKIE } from './remoteAuth.js'

// Bookmarks M1 — the Bookmarks page's two routes:
//   GET    /api/bookmarks      every readable bookmark, newest first, each with
//                              `taskOnBoard` (is its task still on this board?),
//                              plus the names of files that could not be read;
//   DELETE /api/bookmarks/:id  remove one bookmark.
// Both are loopback-only: a signed-in phone can see the board, but bookmarks
// are not served off this Mac (QUESTIONS.md asks whether to relax that).
// Bookmarks never ride the shared SSE task broadcast either — they are
// fetched by their own page only. PIPELINELY_BOOKMARKS_DIR points at a
// throwaway dir, read per request. Every quote is invented. Written red during planning.

const SESSION_ID = '0b5e2c1a-7d3f-4e8a-9c21-5f6a7b8c9d0e'
const TOKEN = 'bookmarks-route-test-token-0123456789abcdefghijk'
const PROXIED = { 'X-Forwarded-For': '100.64.1.2' }
const ON_BOARD_SLUG = 'bookmarks-route-task'

let handle: TestServerHandle
let baseUrl: string
let bookmarksDir: string
let tokenDir: string

async function seedBookmark(id: string, fields: Record<string, unknown>): Promise<void> {
  await fs.mkdir(bookmarksDir, { recursive: true })
  const record = {
    version: 1,
    id,
    kind: 'text',
    title: 'Invented title',
    text: 'Invented quote.',
    note: '',
    tags: [],
    source: { taskSlug: null, sessionId: null },
    createdAt: '2026-10-08T20:14:27.000Z',
    ...fields,
  }
  await fs.writeFile(path.join(bookmarksDir, `${id}.json`), JSON.stringify(record, null, 2))
}

beforeAll(async () => {
  bookmarksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-bookmarks-route-'))
  tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-bookmarks-token-'))
  const tokenFile = path.join(tokenDir, 'token')
  await fs.writeFile(tokenFile, TOKEN, { mode: 0o600 })

  handle = await startTestServer({ PIPELINELY_BOOKMARKS_DIR: bookmarksDir, PIPELINELY_REMOTE_TOKEN_FILE: tokenFile }, async (tasksDir) => {
    const taskDir = path.join(tasksDir, ON_BOARD_SLUG)
    await fs.mkdir(taskDir)
    await fs.writeFile(path.join(taskDir, 'TASK.md'), `# Bookmarks route fixture\n\n## Workspace\n- Repo: cockpit-ai\n- Branch: claude/${ON_BOARD_SLUG}\n`)
  })
  baseUrl = `http://127.0.0.1:${handle.boundPort}`
})

afterAll(async () => {
  await stopTestServer(handle, ['PIPELINELY_BOOKMARKS_DIR', 'PIPELINELY_REMOTE_TOKEN_FILE'])
  await fs.rm(bookmarksDir, { recursive: true, force: true })
  await fs.rm(tokenDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await fs.rm(bookmarksDir, { recursive: true, force: true })
  process.env.PIPELINELY_BOOKMARKS_DIR = bookmarksDir
})

describe('GET /api/bookmarks', () => {
  it('200 with no bookmarks when nothing was ever saved', async () => {
    const res = await fetch(`${baseUrl}/api/bookmarks`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ bookmarks: [], unreadable: [] })
  })

  it('200 newest first, saying whether each bookmark’s task is still on the board', async () => {
    await seedBookmark('20261001T000000Z-aaaaaa', { kind: 'session', text: null, title: 'Older session', source: { taskSlug: ON_BOARD_SLUG, sessionId: SESSION_ID }, createdAt: '2026-10-01T00:00:00.000Z' })
    await seedBookmark('20261002T000000Z-bbbbbb', { title: 'Newer quote', source: { taskSlug: 'long-gone-task', sessionId: SESSION_ID }, createdAt: '2026-10-02T00:00:00.000Z' })
    await seedBookmark('20261003T000000Z-cccccc', { title: 'No task at all', createdAt: '2026-10-03T00:00:00.000Z' })

    const res = await fetch(`${baseUrl}/api/bookmarks`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bookmarks.map((b: { id: string; taskOnBoard: boolean }) => [b.id, b.taskOnBoard])).toEqual([
      ['20261003T000000Z-cccccc', false],
      ['20261002T000000Z-bbbbbb', false],
      ['20261001T000000Z-aaaaaa', true],
    ])
    expect(body.bookmarks[2]).toMatchObject({ kind: 'session', title: 'Older session', text: null })
  })

  it('passes the optional origin, project and task title through, and lists an M0-era file without them', async () => {
    await seedBookmark('20261001T000000Z-aaaaaa', { createdAt: '2026-10-01T00:00:00.000Z' })
    await seedBookmark('20261002T000000Z-bbbbbb', { origin: 'answer', project: 'invented-repo', taskTitle: 'Invented task title', createdAt: '2026-10-02T00:00:00.000Z' })

    const body = await (await fetch(`${baseUrl}/api/bookmarks`)).json()

    expect(body.unreadable).toEqual([])
    expect(body.bookmarks[0]).toMatchObject({ origin: 'answer', project: 'invented-repo', taskTitle: 'Invented task title' })
    expect(body.bookmarks[1]).not.toHaveProperty('origin')
  })

  it('200 with a corrupted file named in `unreadable`, the rest still listed', async () => {
    await seedBookmark('20261002T000000Z-bbbbbb', {})
    await fs.writeFile(path.join(bookmarksDir, '20261003T000000Z-cccccc.json'), '{"kind":')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const body = await (await fetch(`${baseUrl}/api/bookmarks`)).json()
    expect(body.bookmarks.map((b: { id: string }) => b.id)).toEqual(['20261002T000000Z-bbbbbb'])
    expect(body.unreadable).toEqual(['20261003T000000Z-cccccc.json'])
  })

  it('500 and logged when the bookmarks path cannot be read as a directory', async () => {
    await fs.writeFile(bookmarksDir, 'a file where the bookmarks directory should be')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await fetch(`${baseUrl}/api/bookmarks`)
      expect(res.status).toBe(500)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      await fs.rm(bookmarksDir, { force: true })
    }
  })

  it('403 for a signed-in remote device: bookmarks are served on this Mac only', async () => {
    await seedBookmark('20261002T000000Z-bbbbbb', {})
    const res = await fetch(`${baseUrl}/api/bookmarks`, { headers: { ...PROXIED, Cookie: `${REMOTE_SESSION_COOKIE}=${TOKEN}` } })
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('Invented quote.')
  })
})

describe('DELETE /api/bookmarks/:id', () => {
  it('204 and the file is gone', async () => {
    await seedBookmark('20261002T000000Z-bbbbbb', {})
    const res = await fetch(`${baseUrl}/api/bookmarks/20261002T000000Z-bbbbbb`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    await expect(fs.access(path.join(bookmarksDir, '20261002T000000Z-bbbbbb.json'))).rejects.toThrow()
  })

  it('404 for an id that is not a saved bookmark', async () => {
    const res = await fetch(`${baseUrl}/api/bookmarks/20261002T000000Z-000000`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('400 for anything that is not a bookmark id, touching nothing', async () => {
    await seedBookmark('20261002T000000Z-bbbbbb', {})
    const res = await fetch(`${baseUrl}/api/bookmarks/${encodeURIComponent('../20261002T000000Z-bbbbbb')}`, { method: 'DELETE' })
    expect(res.status).toBe(400)
    await expect(fs.access(path.join(bookmarksDir, '20261002T000000Z-bbbbbb.json'))).resolves.toBeUndefined()
  })

  it('403 for a signed-in remote device, touching nothing', async () => {
    await seedBookmark('20261002T000000Z-bbbbbb', {})
    const res = await fetch(`${baseUrl}/api/bookmarks/20261002T000000Z-bbbbbb`, {
      method: 'DELETE',
      headers: { ...PROXIED, Cookie: `${REMOTE_SESSION_COOKIE}=${TOKEN}` },
    })
    expect(res.status).toBe(403)
    await expect(fs.access(path.join(bookmarksDir, '20261002T000000Z-bbbbbb.json'))).resolves.toBeUndefined()
  })
})

describe('bookmarks stay off the shared task snapshot', () => {
  it('GET /api/tasks carries no bookmark content', async () => {
    await seedBookmark('20261002T000000Z-bbbbbb', { text: 'invented-text-that-must-stay-off-the-snapshot' })
    const res = await fetch(`${baseUrl}/api/tasks`)
    expect(await res.text()).not.toContain('invented-text-that-must-stay-off-the-snapshot')
  })
})
