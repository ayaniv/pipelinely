import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const FIXTURE_TASKS_DIR = path.join(__dirname, 'tasks')
export const SETTINGS_PATH = path.join(FIXTURE_TASKS_DIR, 'SETTINGS.json')

// Every spec before this one only ever wrote ORCHESTRATOR_SESSION, a file
// with no committed baseline. Auto mode is the first feature whose behavior
// is a *reaction* to a task's own STATUS changing, so its spec has to mutate
// committed fixture files (STATUS to trigger a transition, and TIMELINE
// because the server appends its own audit line to it). These helpers exist
// so that mutation is always paired with an exact restore — a fixture left
// dirty would silently change what every other spec sees on the board.

export function taskFilePath(slug: string, name: string): string {
  return path.join(FIXTURE_TASKS_DIR, slug, name)
}

export async function readTaskFile(slug: string, name: string): Promise<string | null> {
  return fs.readFile(taskFilePath(slug, name), 'utf-8').catch(() => null)
}

export async function writeTaskFile(slug: string, name: string, content: string): Promise<void> {
  await fs.writeFile(taskFilePath(slug, name), content)
}

export async function removeTaskFile(slug: string, name: string): Promise<void> {
  await fs.rm(taskFilePath(slug, name), { force: true })
}

// Snapshots the named files of the named task dirs and returns the restore
// function. A file that doesn't exist is snapshotted as "absent" and gets
// deleted on restore, so a test that creates AUTO_MODE leaves nothing behind.
export async function snapshotTaskFiles(
  targets: { slug: string; files: string[] }[],
): Promise<() => Promise<void>> {
  const saved: { slug: string; name: string; content: string | null }[] = []
  for (const { slug, files } of targets) {
    for (const name of files) {
      saved.push({ slug, name, content: await readTaskFile(slug, name) })
    }
  }
  return async () => {
    for (const { slug, name, content } of saved) {
      if (content === null) await removeTaskFile(slug, name)
      else await writeTaskFile(slug, name, content)
    }
  }
}

// SETTINGS.json is global fixture state, so the same snapshot/restore rule
// applies — and, like ORCHESTRATOR_SESSION, it must only ever be touched
// while holding withOrchestratorSessionLock (see that file's own comment).
export async function snapshotSettings(): Promise<() => Promise<void>> {
  const saved = await fs.readFile(SETTINGS_PATH, 'utf-8').catch(() => null)
  return async () => {
    if (saved === null) await fs.rm(SETTINGS_PATH, { force: true })
    else await fs.writeFile(SETTINGS_PATH, saved)
  }
}
