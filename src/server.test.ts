import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
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
    expect(JSON.parse(await fs.readFile(path.join(tmpDir, 'SETTINGS.json'), 'utf-8'))).toEqual({ autoMode: true, creaturePlacement: 'header', weeklyFocusEnabled: true, qaStartPolicy: 'ask-every-time' })

    const api = await fetch(`${baseUrl}/api/tasks`)
    expect((await api.json()).settings).toEqual({ autoMode: true, creaturePlacement: 'header', weeklyFocusEnabled: true, qaStartPolicy: 'ask-every-time' })

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

  const postSettings = (body: unknown) =>
    fetch(`${baseUrl}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('merges creaturePlacement on its own without erasing autoMode, and the other way round', async () => {
    expect((await postSettings({ autoMode: true })).status).toBe(200)
    expect((await postSettings({ creaturePlacement: 'off' })).status).toBe(200)
    expect(JSON.parse(await fs.readFile(path.join(tmpDir, 'SETTINGS.json'), 'utf-8'))).toEqual({ autoMode: true, creaturePlacement: 'off', weeklyFocusEnabled: true, qaStartPolicy: 'ask-every-time' })

    expect((await postSettings({ autoMode: false })).status).toBe(200)
    expect(JSON.parse(await fs.readFile(path.join(tmpDir, 'SETTINGS.json'), 'utf-8'))).toEqual({ autoMode: false, creaturePlacement: 'off', weeklyFocusEnabled: true, qaStartPolicy: 'ask-every-time' })
    expect((await (await fetch(`${baseUrl}/api/tasks`)).json()).settings).toEqual({ autoMode: false, creaturePlacement: 'off', weeklyFocusEnabled: true, qaStartPolicy: 'ask-every-time' })

    // Restore for other tests sharing this tmpDir/server.
    await postSettings({ creaturePlacement: 'header' })
  })

  it.each(['cockpit-ai-ui-preapproved', 'ask-every-time'])('records qaStartPolicy %s without dropping autoMode or creaturePlacement', async (qaStartPolicy) => {
    expect((await postSettings({ autoMode: true, creaturePlacement: 'off' })).status).toBe(200)
    expect((await postSettings({ qaStartPolicy })).status).toBe(200)

    const expected = { autoMode: true, creaturePlacement: 'off', weeklyFocusEnabled: true, qaStartPolicy }
    expect(JSON.parse(await fs.readFile(path.join(tmpDir, 'SETTINGS.json'), 'utf-8'))).toEqual(expected)
    expect((await (await fetch(`${baseUrl}/api/tasks`)).json()).settings).toEqual(expected)

    // Restore for other tests sharing this tmpDir/server.
    await postSettings({ autoMode: false, creaturePlacement: 'header', weeklyFocusEnabled: true, qaStartPolicy: 'ask-every-time' })
  })

  it.each([
    ['an unknown policy', { qaStartPolicy: 'always' }],
    ['a boolean policy', { qaStartPolicy: true }],
    ['a valid field next to an invalid policy', { autoMode: true, qaStartPolicy: 'preapproved' }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const before = await fs.readFile(path.join(tmpDir, 'SETTINGS.json'), 'utf-8').catch(() => null)
    expect((await postSettings(body)).status).toBe(400)
    expect(await fs.readFile(path.join(tmpDir, 'SETTINGS.json'), 'utf-8').catch(() => null)).toBe(before)
  })

  it.each([
    ['an unknown placement', { creaturePlacement: 'rail' }],
    ['a non-string placement', { creaturePlacement: true }],
    ['a valid field next to an invalid one', { autoMode: true, creaturePlacement: 'rail' }],
    ['neither field', {}],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const before = await fs.readFile(path.join(tmpDir, 'SETTINGS.json'), 'utf-8').catch(() => null)
    expect((await postSettings(body)).status).toBe(400)
    expect(await fs.readFile(path.join(tmpDir, 'SETTINGS.json'), 'utf-8').catch(() => null)).toBe(before)
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

describe('creature assignment on refresh', () => {
  it('stores a CREATURE for a new task and serves it in /api/tasks', async () => {
    await createTaskDir('creature-new-task')
    await waitForTask('creature-new-task')
    await expect.poll(async () => {
      const data = (await (await fetch(`${baseUrl}/api/tasks`)).json()) as { tasks: { slug: string; creature: unknown }[] }
      return data.tasks.find((t) => t.slug === 'creature-new-task')?.creature ?? null
    }, { timeout: 5000 }).not.toBeNull()
    const stored = JSON.parse(await fs.readFile(path.join(tmpDir, 'creature-new-task', 'CREATURE'), 'utf-8'))
    expect(stored).toEqual(expect.objectContaining({ name: expect.any(String), color: expect.stringMatching(/^#[0-9a-f]{6}$/) }))
  })

  it('shows a hand-edited CREATURE on the next broadcast', async () => {
    await createTaskDir('creature-hand-edit')
    await waitForTask('creature-hand-edit')
    const edited = { name: 'Handmade', color: '#112233', shape: '40% 40% 40% 40% / 40% 40% 40% 40%' }
    await expect.poll(async () => fs.access(path.join(tmpDir, 'creature-hand-edit', 'CREATURE')).then(() => true, () => false), { timeout: 5000 }).toBe(true)
    await fs.writeFile(path.join(tmpDir, 'creature-hand-edit', 'CREATURE'), JSON.stringify(edited))
    await expect.poll(async () => {
      const data = (await (await fetch(`${baseUrl}/api/tasks`)).json()) as { tasks: { slug: string; creature: unknown }[] }
      return data.tasks.find((t) => t.slug === 'creature-hand-edit')?.creature
    }, { timeout: 5000 }).toEqual(edited)
  })
})

describe('weekly focus switch', () => {
  const postJson = (route: string, body: unknown) =>
    fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const snapshot = async () => (await fetch(`${baseUrl}/api/tasks`)).json()
  const focusPath = () => path.join(tmpDir, 'WEEKLY_FOCUS')

  afterEach(async () => {
    await postJson('/settings', { weeklyFocusEnabled: true })
    await fs.rm(focusPath(), { force: true })
  })

  it('accepts a boolean weeklyFocusEnabled and merges it without erasing the other settings', async () => {
    await postJson('/settings', { autoMode: true })
    expect((await postJson('/settings', { weeklyFocusEnabled: false })).status).toBe(200)
    expect(JSON.parse(await fs.readFile(path.join(tmpDir, 'SETTINGS.json'), 'utf-8'))).toEqual({
      autoMode: true, creaturePlacement: 'header', weeklyFocusEnabled: false, qaStartPolicy: 'ask-every-time',
    })
    expect((await snapshot()).settings.weeklyFocusEnabled).toBe(false)
    await postJson('/settings', { autoMode: false })
  })

  it.each([['a string', 'false'], ['a number', 0], ['null', null]])('rejects %s with 400 and writes nothing', async (_label, value) => {
    const before = await fs.readFile(path.join(tmpDir, 'SETTINGS.json'), 'utf-8').catch(() => null)
    expect((await postJson('/settings', { weeklyFocusEnabled: value })).status).toBe(400)
    expect(await fs.readFile(path.join(tmpDir, 'SETTINGS.json'), 'utf-8').catch(() => null)).toBe(before)
  })

  it('serves the stored focus while enabled', async () => {
    expect((await postJson('/weekly-focus', { text: 'ship it' })).status).toBe(200)
    expect((await snapshot()).weeklyFocus).toBe('ship it')
  })

  it('serves an empty focus while disabled, but keeps the stored text so re-enabling brings it back', async () => {
    await postJson('/weekly-focus', { text: 'ship it' })
    await postJson('/settings', { weeklyFocusEnabled: false })
    expect((await snapshot()).weeklyFocus).toBe('')
    expect(await fs.readFile(focusPath(), 'utf-8')).toBe('ship it')

    await postJson('/settings', { weeklyFocusEnabled: true })
    expect((await snapshot()).weeklyFocus).toBe('ship it')
  })

  it('refuses a focus edit while disabled with 409 and leaves the stored text alone', async () => {
    await postJson('/weekly-focus', { text: 'ship it' })
    await postJson('/settings', { weeklyFocusEnabled: false })

    const res = await postJson('/weekly-focus', { text: 'sneaky' })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'weekly focus is disabled' })
    expect(await fs.readFile(focusPath(), 'utf-8')).toBe('ship it')
  })
})
