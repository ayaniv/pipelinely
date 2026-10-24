import fs from 'node:fs/promises'
import path from 'node:path'
import { readSettings } from './taskParser.js'
import type { Settings } from './types.js'

export const WEEKLY_FOCUS_FILE = 'WEEKLY_FOCUS'

// The one place that knows the Settings switch exists: everything that reads
// the focus goes through effectiveWeeklyFocus / readEffectiveWeeklyFocus, so
// "disabled" cannot be honoured in one reader and forgotten in another.
export function isWeeklyFocusEnabled(settings: Settings): boolean {
  return settings.weeklyFocusEnabled
}

// What the rest of the system sees as "this week's focus": the trimmed stored
// text, or the empty string — "no focus" — while the switch is off.
export function effectiveWeeklyFocus(settings: Settings, storedText: string): string {
  return isWeeklyFocusEnabled(settings) ? storedText.trim() : ''
}

// The one read of the WEEKLY_FOCUS file, ignoring the switch (the server keeps
// the stored text so re-enabling restores it). A missing file is the normal
// "no focus set" state; any other failure rejects, so each caller decides how
// loudly to report it instead of it being mistaken for "no focus".
export async function readStoredWeeklyFocus(tasksDir: string): Promise<string> {
  try {
    return (await fs.readFile(path.join(tasksDir, WEEKLY_FOCUS_FILE), 'utf-8')).trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

// A tasks dir that isn't there is a misconfiguration (a stale TASKS_DIR leaked
// into the shell), not "no focus": reading it as empty would silently turn the
// dispatch gate off.
async function assertTasksDirExists(tasksDir: string): Promise<void> {
  let isDirectory = false
  try {
    isDirectory = (await fs.stat(tasksDir)).isDirectory()
  } catch {
    // falls through to the same error as a non-directory
  }
  if (!isDirectory) throw new Error(`Tasks dir ${tasksDir} does not exist or is not a directory — check TASKS_DIR`)
}

export async function readEffectiveWeeklyFocus(tasksDir: string): Promise<string> {
  await assertTasksDirExists(tasksDir)
  const settings = await readSettings(tasksDir)
  if (!isWeeklyFocusEnabled(settings)) return ''
  return effectiveWeeklyFocus(settings, await readStoredWeeklyFocus(tasksDir))
}
