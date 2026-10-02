import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// POST /answer-dialog/:slug — the server half of answering a blocked worker's
// Claude Code dialog from the dashboard (dashboard-answer-blocked-workers M0).
//
// Every case here is a refusal: the e2e webServer is deliberately not the
// canonical instance (no COCKPIT_DISPATCH_ENABLED, see playwright.config.ts),
// so the one path that would press a key is unreachable by construction. The
// happy path (re-check, send, confirm, log) is covered by vitest against
// injected fakes, never by a live server.
//
// No real terminal is touched: the webServer resolves the terminal
// multiplexer binary to e2e/fixtures/bin/ (dashboard-show-blocked-workers),
// whose sessions are the files in e2e/fixtures/panes/. M0 makes that fake
// append every command that could change a session (send-keys, kill-session,
// ...) to WRITE_ATTEMPTS_LOG before failing, which is how these cases prove
// "nothing was sent", not just "the response said so". Unmodelled reads are
// not recorded, so a parallel spec's /focus click can't fail this check.
//

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WRITE_ATTEMPTS_LOG = path.join(__dirname, 'fixtures', 'fake-mux', 'write-attempts.log')

const BLOCKED_SLUG = 'answer-dialog-perm'
const BLOCKED_SESSION = `worker-${BLOCKED_SLUG}`
const NOT_BLOCKED_SLUG = 'answer-dialog-none'

// Comfortably above the COCKPIT_APPROVAL_POLL_MS the e2e webServer sets.
const POLL_SETTLE_MS = 10_000

interface ApiDialogOption {
  number: number
  label: string
}

interface ApiApprovalPrompt {
  session: string
  question: string
  summary: string
  options: ApiDialogOption[]
  fingerprint: string
}

async function approvalPromptFromApi(request: APIRequestContext, slug: string): Promise<ApiApprovalPrompt | null | undefined> {
  const response = await request.get('/api/tasks')
  const snapshot = (await response.json()) as { tasks: { slug: string; approvalPrompt?: ApiApprovalPrompt | null }[] }
  return snapshot.tasks.find((task) => task.slug === slug)?.approvalPrompt
}

async function waitForPrompt(request: APIRequestContext, slug: string): Promise<ApiApprovalPrompt> {
  await expect.poll(async () => (await approvalPromptFromApi(request, slug))?.fingerprint ?? null, { timeout: POLL_SETTLE_MS }).not.toBeNull()
  return (await approvalPromptFromApi(request, slug))!
}

async function readWriteAttempts(): Promise<string> {
  try {
    return await fs.readFile(WRITE_ATTEMPTS_LOG, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

function validBody(prompt: ApiApprovalPrompt) {
  return { session: prompt.session, option: 1, fingerprint: prompt.fingerprint }
}

test.describe('answer-dialog route refusals', () => {
  test.beforeAll(async () => {
    await fs.rm(WRITE_ATTEMPTS_LOG, { force: true })
  })

  test.afterEach(async () => {
    expect(await readWriteAttempts()).toBe('')
  })

  test('the snapshot carries the dialog options and a fingerprint the client echoes back', async ({ request }) => {
    const prompt = await waitForPrompt(request, BLOCKED_SLUG)
    expect(prompt.session).toBe(BLOCKED_SESSION)
    expect(prompt.options.map((option) => option.number)).toEqual([1, 2, 3])
    expect(prompt.options[0].label).toBe('Yes')
    expect(prompt.options[2].label).toContain('No')
    expect(prompt.fingerprint).toMatch(/^[0-9a-f]{16,}$/)
  })

  test('a GET never answers a dialog', async ({ request }) => {
    const response = await request.get(`/answer-dialog/${BLOCKED_SLUG}`)
    expect(response.status()).not.toBe(200)
    expect(response.headers()['content-type'] ?? '').not.toContain('application/json')
  })

  test('a non-JSON body (a cross-site "simple" form POST) is refused before anything else', async ({ request }) => {
    const prompt = await waitForPrompt(request, BLOCKED_SLUG)
    const response = await request.post(`/answer-dialog/${BLOCKED_SLUG}`, {
      headers: { 'Content-Type': 'text/plain' },
      data: JSON.stringify(validBody(prompt)),
    })
    expect(response.status()).toBe(415)
    expect((await response.json()).reason).toBe('not-json')
  })

  test('a request whose Origin is another site is refused', async ({ request }) => {
    const prompt = await waitForPrompt(request, BLOCKED_SLUG)
    const response = await request.post(`/answer-dialog/${BLOCKED_SLUG}`, {
      headers: { Origin: 'http://evil.example' },
      data: validBody(prompt),
    })
    expect(response.status()).toBe(403)
    expect((await response.json()).reason).toBe('cross-site')
  })

  test('a valid loopback request on a non-canonical instance is refused and sends nothing', async ({ request }) => {
    const prompt = await waitForPrompt(request, BLOCKED_SLUG)
    const response = await request.post(`/answer-dialog/${BLOCKED_SLUG}`, { data: validBody(prompt) })
    expect(response.status()).toBe(403)
    expect((await response.json()).reason).toBe('not-canonical')
    // Still blocked: the refusal left the worker exactly where it was.
    expect((await approvalPromptFromApi(request, BLOCKED_SLUG))?.fingerprint).toBe(prompt.fingerprint)
  })

  test('a task with no detected dialog has no prompt to answer', async ({ request }) => {
    await waitForPrompt(request, BLOCKED_SLUG)
    expect(await approvalPromptFromApi(request, NOT_BLOCKED_SLUG)).toBeNull()
  })
})
