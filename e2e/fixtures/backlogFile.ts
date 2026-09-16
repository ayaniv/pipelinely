import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withFixtureLock } from './fixtureLock.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const BACKLOG_PATH = path.join(__dirname, 'tasks', 'BACKLOG.md')

// e2e/fixtures/tasks/BACKLOG.md is a single file shared by every spec that
// reads or writes the backlog — backlog-batch-dispatch.spec.ts asserts it
// holds exactly its four committed items, while backlog-shelve-resume.spec.ts
// appends and removes entries mid-test. With fullyParallel workers those two
// otherwise race: a shelve landing mid-run makes the batch spec see five
// checkbox rows instead of four, and a batch-spec page load can observe a
// half-restored file.
//
// **Ordering:** a test that also needs withOrchestratorSessionLock must take
// THIS lock first — see fixtureLock.ts.
export async function withBacklogFileLock<T>(fn: () => Promise<T>): Promise<T> {
  return withFixtureLock('backlog-file', fn)
}

// Runs `fn` with BACKLOG.md's committed contents restored afterwards no
// matter how `fn` ends, so a failing assertion can never leave the shared
// fixture file mutated for every later spec. Does not take the lock itself:
// a caller usually needs the lock to span more than just the mutation (the
// page load and assertions that read the mutated file), so the two compose
// rather than nest invisibly.
export async function withRestoredBacklog<T>(fn: (originalContent: string) => Promise<T>): Promise<T> {
  const original = await fs.readFile(BACKLOG_PATH, 'utf-8')
  try {
    return await fn(original)
  } finally {
    await fs.writeFile(BACKLOG_PATH, original)
  }
}

// Appends one "shelved" backlog entry — the exact on-disk shape POST
// /shelve/:slug produces — so a resume test can start from a backlog that
// already points at an existing task dir without having to shelve one first.
// No context/reason line: a machine-written entry never carries one.
export async function appendShelvedEntry(
  description: string,
  date: string,
  slug: string,
  project: string | null,
): Promise<void> {
  const raw = await fs.readFile(BACKLOG_PATH, 'utf-8')
  const withNewline = raw.endsWith('\n') ? raw : raw + '\n'
  const tag = project ? `[${project}] ` : ''
  await fs.writeFile(
    BACKLOG_PATH,
    `${withNewline}- [ ] ${tag}${description} (${date})\n  shelved: ${slug}\n`,
  )
}
