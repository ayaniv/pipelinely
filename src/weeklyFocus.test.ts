import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SETTINGS } from './taskParser.js'
import { effectiveWeeklyFocus, isWeeklyFocusEnabled, readEffectiveWeeklyFocus, readStoredWeeklyFocus, WEEKLY_FOCUS_FILE } from './weeklyFocus.js'

let tasksDir: string

beforeEach(async () => {
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'weekly-focus-'))
})

afterEach(async () => {
  await fs.rm(tasksDir, { recursive: true, force: true })
})

const writeSettings = (content: string) => fs.writeFile(path.join(tasksDir, 'SETTINGS.json'), content)
const writeFocus = (content: string) => fs.writeFile(path.join(tasksDir, WEEKLY_FOCUS_FILE), content)

describe('isWeeklyFocusEnabled', () => {
  it('reads the flag off the settings', () => {
    expect(isWeeklyFocusEnabled({ ...DEFAULT_SETTINGS, weeklyFocusEnabled: true })).toBe(true)
    expect(isWeeklyFocusEnabled({ ...DEFAULT_SETTINGS, weeklyFocusEnabled: false })).toBe(false)
  })

  it('is on by default', () => {
    expect(isWeeklyFocusEnabled(DEFAULT_SETTINGS)).toBe(true)
  })
})

describe('effectiveWeeklyFocus', () => {
  it('passes the stored text through, trimmed, while enabled', () => {
    expect(effectiveWeeklyFocus(DEFAULT_SETTINGS, '  ship it \n')).toBe('ship it')
  })

  it('is empty while disabled, whatever is stored', () => {
    expect(effectiveWeeklyFocus({ ...DEFAULT_SETTINGS, weeklyFocusEnabled: false }, 'ship it')).toBe('')
  })
})

describe('readEffectiveWeeklyFocus', () => {
  it('returns the trimmed file when there is no settings file (default: enabled)', async () => {
    await writeFocus('ship it\n')
    expect(await readEffectiveWeeklyFocus(tasksDir)).toBe('ship it')
  })

  it('returns the text when the flag is true', async () => {
    await writeSettings('{"weeklyFocusEnabled": true}')
    await writeFocus('ship it')
    expect(await readEffectiveWeeklyFocus(tasksDir)).toBe('ship it')
  })

  it('returns the empty string when the flag is false, leaving the stored text on disk', async () => {
    await writeSettings('{"weeklyFocusEnabled": false}')
    await writeFocus('ship it')
    expect(await readEffectiveWeeklyFocus(tasksDir)).toBe('')
    expect(await fs.readFile(path.join(tasksDir, WEEKLY_FOCUS_FILE), 'utf-8')).toBe('ship it')
  })

  it.each([
    ['a string', '{"weeklyFocusEnabled": "false"}'],
    ['a number', '{"weeklyFocusEnabled": 0}'],
    ['null', '{"weeklyFocusEnabled": null}'],
    ['malformed JSON', '{not json'],
  ])('treats %s as enabled', async (_label, settings) => {
    await writeSettings(settings)
    await writeFocus('ship it')
    expect(await readEffectiveWeeklyFocus(tasksDir)).toBe('ship it')
  })

  it('rejects naming the directory when the tasks dir itself is missing, instead of reading it as no focus', async () => {
    const missing = path.join(tasksDir, 'nope')
    await expect(readEffectiveWeeklyFocus(missing)).rejects.toThrow(missing)
  })

  it('is empty when there is no focus file, enabled or not', async () => {
    expect(await readEffectiveWeeklyFocus(tasksDir)).toBe('')
    await writeSettings('{"weeklyFocusEnabled": false}')
    expect(await readEffectiveWeeklyFocus(tasksDir)).toBe('')
  })
})

describe('readStoredWeeklyFocus', () => {
  it('returns the trimmed file regardless of the Settings switch', async () => {
    await writeSettings('{"weeklyFocusEnabled": false}')
    await writeFocus('  ship it\n')
    expect(await readStoredWeeklyFocus(tasksDir)).toBe('ship it')
  })

  it('is empty when the file is absent', async () => {
    expect(await readStoredWeeklyFocus(tasksDir)).toBe('')
  })

  it('rejects on any read error other than a missing file', async () => {
    await fs.mkdir(path.join(tasksDir, WEEKLY_FOCUS_FILE))
    await expect(readStoredWeeklyFocus(tasksDir)).rejects.toThrow(/EISDIR/)
  })

  it('makes readEffectiveWeeklyFocus reject too while enabled, but not while disabled (nothing is read)', async () => {
    await fs.mkdir(path.join(tasksDir, WEEKLY_FOCUS_FILE))
    await expect(readEffectiveWeeklyFocus(tasksDir)).rejects.toThrow(/EISDIR/)
    await writeSettings('{"weeklyFocusEnabled": false}')
    expect(await readEffectiveWeeklyFocus(tasksDir)).toBe('')
  })
})
