import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHELL_ROUTES, matchShellRoute, taskUrl } from './routes'

describe('matchShellRoute', () => {
  it.each([
    ['/', 'inprogress'],
    ['/backlog', 'backlog'],
    ['/done', 'done'],
    ['/you', 'you'],
    ['/settings', 'settings'],
    ['/help', 'help'],
    ['/docs', 'docs'],
    ['/task/demo-task', 'task'],
    ['/task/with%20space', 'task'],
  ])('%s → %s', (pathname, id) => {
    expect(matchShellRoute(pathname)).toBe(id)
  })

  it.each(['/task/', '/task', '/nope', '/backlog/extra', '/art/app-mark-v2.png'])(
    '%s matches no shell route',
    (pathname) => {
      expect(matchShellRoute(pathname)).toBeNull()
    },
  )
})

// SHELL_ROUTES (client) and server.ts's sendDashboardShell registrations are
// two records of the same list that can't import each other — the same
// drift boardTabRoutes.test.tsx guards for the board tabs. Add a route only
// on the client and it works in-session but 404s on a cold load or a shared
// link; add it only on the server and it serves a shell no route matches.
describe('SHELL_ROUTES ↔ server.ts parity', () => {
  let serverShellPaths: string[]

  beforeAll(async () => {
    const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'server.ts')
    const serverSource = await fs.readFile(serverPath, 'utf-8')
    serverShellPaths = [...serverSource.matchAll(/app\.get\('([^']+)',\s*sendDashboardShell\)/g)].map((m) => m[1])
    if (serverShellPaths.length === 0) {
      throw new Error('no app.get(..., sendDashboardShell) registrations found in src/server.ts — extraction regex is stale')
    }
  })

  it('every client shell route is served by the server', () => {
    for (const { path: routePath } of SHELL_ROUTES) {
      expect(serverShellPaths, `server.ts does not serve ${routePath}`).toContain(routePath)
    }
  })

  it('every server shell route has a client route', () => {
    const clientPaths = SHELL_ROUTES.map((r) => r.path)
    for (const serverPath of serverShellPaths) {
      expect(clientPaths, `no SHELL_ROUTES entry for ${serverPath}`).toContain(serverPath)
    }
  })
})

describe('taskUrl', () => {
  it('is /task/<slug>, percent-encoding an unsafe slug', () => {
    expect(taskUrl('demo-task')).toBe('/task/demo-task')
    expect(taskUrl('a b/c')).toBe('/task/a%20b%2Fc')
  })

  it('carries the selected stage as ?stage=, and omits it when there is none', () => {
    expect(taskUrl('demo-task', 'cr-fixes')).toBe('/task/demo-task?stage=cr-fixes')
    expect(taskUrl('demo-task', null)).toBe('/task/demo-task')
    expect(taskUrl('demo-task', '')).toBe('/task/demo-task')
  })

  it('round-trips through the shell route matcher', () => {
    expect(matchShellRoute(new URL(taskUrl('a b/c'), 'http://x').pathname)).toBe('task')
  })
})
