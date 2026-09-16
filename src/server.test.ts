import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'

let tmpDir: string
let baseUrl: string
let server: Server

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-server-test-'))
  process.env.TASKS_DIR = tmpDir
  const { app } = await import('./server.js')
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a network address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
  await fs.rm(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await fs.writeFile(
    path.join(tmpDir, 'BACKLOG.md'),
    ['- [ ] First idea (2026-07-01)', '- [ ] Second idea (2026-07-02)', '  old context'].join('\n'),
  )
})

describe('POST /backlog/edit/:index', () => {
  it('rewrites the item at the given index and persists it to BACKLOG.md', async () => {
    const res = await fetch(`${baseUrl}/backlog/edit/1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'Second idea, revised',
        date: '2026-07-03',
        context: 'new context',
        original: { description: 'Second idea', date: '2026-07-02', context: 'old context', done: false },
      }),
    })
    expect(res.status).toBe(200)
    const content = await fs.readFile(path.join(tmpDir, 'BACKLOG.md'), 'utf-8')
    expect(content).toContain('Second idea, revised (2026-07-03)')
    expect(content).toContain('new context')
  })

  it('returns 400 for an out-of-range index', async () => {
    const res = await fetch(`${baseUrl}/backlog/edit/99`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'x',
        date: null,
        context: null,
        original: { description: 'First idea', date: '2026-07-01', context: null, done: false },
      }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for a malformed (non-numeric) index', async () => {
    const res = await fetch(`${baseUrl}/backlog/edit/not-a-number`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'x',
        date: null,
        context: null,
        original: { description: 'First idea', date: '2026-07-01', context: null, done: false },
      }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when BACKLOG.md does not exist', async () => {
    await fs.rm(path.join(tmpDir, 'BACKLOG.md'))
    const res = await fetch(`${baseUrl}/backlog/edit/0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'x',
        date: null,
        context: null,
        original: { description: 'First idea', date: '2026-07-01', context: null, done: false },
      }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 409 with a conflict body when the original snapshot is stale', async () => {
    const res = await fetch(`${baseUrl}/backlog/edit/0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'x',
        date: null,
        context: null,
        original: { description: 'Stale snapshot', date: null, context: null, done: false },
      }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'conflict' })
  })

  it('a tagged item edited with its full original succeeds — pins the coerceBacklogOriginal project fix', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'BACKLOG.md'),
      '- [ ] [cockpit-ai] First idea (2026-07-01)',
    )
    const res = await fetch(`${baseUrl}/backlog/edit/0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'First idea, revised',
        date: '2026-07-01',
        context: null,
        project: 'cockpit-ai',
        original: { description: 'First idea', date: '2026-07-01', context: null, done: false, project: 'cockpit-ai' },
      }),
    })
    expect(res.status).toBe(200)
    const content = await fs.readFile(path.join(tmpDir, 'BACKLOG.md'), 'utf-8')
    expect(content).toContain('[cockpit-ai] First idea, revised (2026-07-01)')
  })

  it('returns 400 with invalid-project and leaves the file unchanged', async () => {
    const before = await fs.readFile(path.join(tmpDir, 'BACKLOG.md'), 'utf-8')
    const res = await fetch(`${baseUrl}/backlog/edit/0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'First idea',
        date: '2026-07-01',
        context: null,
        project: 'not a slug',
        original: { description: 'First idea', date: '2026-07-01', context: null, done: false, project: null },
      }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid-project' })
    expect(await fs.readFile(path.join(tmpDir, 'BACKLOG.md'), 'utf-8')).toBe(before)
  })

  it('returns 400 with project-collision and leaves the file unchanged', async () => {
    const before = await fs.readFile(path.join(tmpDir, 'BACKLOG.md'), 'utf-8')
    const res = await fetch(`${baseUrl}/backlog/edit/0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: '[WIP] First idea',
        date: '2026-07-01',
        context: null,
        project: null,
        original: { description: 'First idea', date: '2026-07-01', context: null, done: false, project: null },
      }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'project-collision' })
    expect(await fs.readFile(path.join(tmpDir, 'BACKLOG.md'), 'utf-8')).toBe(before)
  })
})

describe('POST /backlog/dismiss/:index', () => {
  it('removes the item at the given index and persists it to BACKLOG.md', async () => {
    const res = await fetch(`${baseUrl}/backlog/dismiss/1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        original: { description: 'Second idea', date: '2026-07-02', context: 'old context', done: false },
      }),
    })
    expect(res.status).toBe(200)
    const content = await fs.readFile(path.join(tmpDir, 'BACKLOG.md'), 'utf-8')
    expect(content).not.toContain('Second idea')
    expect(content).toContain('First idea')
  })

  it('returns 400 for an out-of-range index', async () => {
    const res = await fetch(`${baseUrl}/backlog/dismiss/99`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        original: { description: 'First idea', date: '2026-07-01', context: null, done: false },
      }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for a malformed (non-numeric) index', async () => {
    const res = await fetch(`${baseUrl}/backlog/dismiss/not-a-number`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        original: { description: 'First idea', date: '2026-07-01', context: null, done: false },
      }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when the original snapshot is missing from the body', async () => {
    const res = await fetch(`${baseUrl}/backlog/dismiss/0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when BACKLOG.md does not exist', async () => {
    await fs.rm(path.join(tmpDir, 'BACKLOG.md'))
    const res = await fetch(`${baseUrl}/backlog/dismiss/0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        original: { description: 'First idea', date: '2026-07-01', context: null, done: false },
      }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 409 with a conflict body when the original snapshot is stale', async () => {
    const res = await fetch(`${baseUrl}/backlog/dismiss/0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        original: { description: 'Stale snapshot', date: null, context: null, done: false },
      }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'conflict' })
    const content = await fs.readFile(path.join(tmpDir, 'BACKLOG.md'), 'utf-8')
    expect(content).toContain('First idea')
  })
})

describe('POST /settings', () => {
  it('writes the global autoMode switch and reflects it in GET /api/tasks', async () => {
    const res = await fetch(`${baseUrl}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoMode: true }),
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(await fs.readFile(path.join(tmpDir, 'SETTINGS.json'), 'utf-8'))).toEqual({ autoMode: true })

    const api = await fetch(`${baseUrl}/api/tasks`)
    expect((await api.json()).settings).toEqual({ autoMode: true })

    // Restore for other tests sharing this tmpDir/server.
    await fetch(`${baseUrl}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoMode: false }),
    })
  })

  it('rejects a non-boolean body with 400', async () => {
    const res = await fetch(`${baseUrl}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoMode: 'yes' }),
    })
    expect(res.status).toBe(400)
  })
})

async function waitForTask(slug: string): Promise<void> {
  await expect.poll(async () => {
    const res = await fetch(`${baseUrl}/api/tasks`)
    const data = (await res.json()) as { tasks: { slug: string }[] }
    return data.tasks.some((t) => t.slug === slug)
  }, { timeout: 5000 }).toBe(true)
}

async function createTaskDir(slug: string): Promise<void> {
  await fs.mkdir(path.join(tmpDir, slug), { recursive: true })
  await fs.writeFile(path.join(tmpDir, slug, 'STATUS'), 'working\n')
  await waitForTask(slug)
}

describe('POST /task-auto-mode/:slug', () => {
  it('writes auto', async () => {
    const slug = 'auto-mode-task-a'
    await createTaskDir(slug)
    const res = await fetch(`${baseUrl}/task-auto-mode/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ override: 'auto' }),
    })
    expect(res.status).toBe(200)
    expect((await fs.readFile(path.join(tmpDir, slug, 'AUTO_MODE'), 'utf-8')).trim()).toBe('auto')
  })

  it('writes manual', async () => {
    const slug = 'auto-mode-task-b'
    await createTaskDir(slug)
    const res = await fetch(`${baseUrl}/task-auto-mode/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ override: 'manual' }),
    })
    expect(res.status).toBe(200)
    expect((await fs.readFile(path.join(tmpDir, slug, 'AUTO_MODE'), 'utf-8')).trim()).toBe('manual')
  })

  it('deletes the AUTO_MODE file on "inherit" rather than writing the word', async () => {
    const slug = 'auto-mode-task-c'
    await createTaskDir(slug)
    await fs.writeFile(path.join(tmpDir, slug, 'AUTO_MODE'), 'auto')
    const res = await fetch(`${baseUrl}/task-auto-mode/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ override: 'inherit' }),
    })
    expect(res.status).toBe(200)
    await expect(fs.readFile(path.join(tmpDir, slug, 'AUTO_MODE'), 'utf-8')).rejects.toThrow()
  })

  it('returns 400 on an unknown override value', async () => {
    const slug = 'auto-mode-task-d'
    await createTaskDir(slug)
    const res = await fetch(`${baseUrl}/task-auto-mode/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ override: 'sometimes' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 on an unknown slug', async () => {
    const res = await fetch(`${baseUrl}/task-auto-mode/does-not-exist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ override: 'auto' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /annotate-plan/:slug', () => {
  // The only branch of this route safe to exercise for real in a test: it
  // returns before ever calling openAnnotationSession (which would shell out
  // to osascript/tmux and open a real iTerm2 tab on whatever machine runs
  // this suite). The success path is covered by e2e/plannotator-button.spec.ts
  // instead, with the actual dispatch stubbed at the network layer.
  it('returns 404 when the task has no tech-design.md', async () => {
    const slug = 'no-plan-task'
    await fs.mkdir(path.join(tmpDir, slug), { recursive: true })
    const res = await fetch(`${baseUrl}/annotate-plan/${slug}`, { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
