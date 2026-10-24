import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CREATURE_COLORS,
  CREATURE_NAMES,
  assignMissingCreatures,
  chooseCreature,
  parseCreatureContent,
  seededShape,
  shadeColor,
} from './creature.js'
import type { Task, TaskCreature } from './types.js'

const SHAPE_RE = /^(\d{2})% (\d{2})% (\d{2})% (\d{2})% \/ (\d{2})% (\d{2})% (\d{2})% (\d{2})%$/
const PARENT: TaskCreature = { name: 'Pip', color: '#a8d8c9', shape: '50% 50% 50% 50% / 50% 50% 50% 50%' }

function makeCreature(overrides: Partial<TaskCreature> = {}): TaskCreature {
  return { ...PARENT, ...overrides }
}

// Only the fields the assigner reads; the rest of Task is irrelevant here.
function makeTaskStub(slug: string, overrides: Partial<Task> = {}): Task {
  return { slug, status: 'working', creature: null, ...overrides } as Task
}

describe('seededShape', () => {
  it('is an asymmetric 8-value radius with every value in [30, 70]', () => {
    const match = seededShape('some-task').match(SHAPE_RE)
    expect(match).not.toBeNull()
    for (const value of match!.slice(1).map(Number)) {
      expect(value).toBeGreaterThanOrEqual(30)
      expect(value).toBeLessThanOrEqual(70)
    }
  })

  it('is deterministic per slug and differs between slugs', () => {
    expect(seededShape('a-task')).toBe(seededShape('a-task'))
    expect(seededShape('a-task')).not.toBe(seededShape('another-task'))
  })
})

describe('shadeColor', () => {
  it('lightens with a positive amount and darkens with a negative one', () => {
    expect(shadeColor('#808080', 0.5)).toBe('#c0c0c0')
    expect(shadeColor('#808080', -0.5)).toBe('#404040')
  })

  it('leaves a colour unchanged at 0 and clamps to white / black', () => {
    expect(shadeColor('#336699', 0)).toBe('#336699')
    expect(shadeColor('#336699', 1)).toBe('#ffffff')
    expect(shadeColor('#336699', -1)).toBe('#000000')
  })
})

describe('parseCreatureContent', () => {
  it('accepts a valid creature', () => {
    expect(parseCreatureContent(JSON.stringify(PARENT))).toEqual(PARENT)
  })

  it.each([
    ['not JSON', 'nope'],
    ['a JSON array', '[]'],
    ['a JSON null', 'null'],
    ['an empty name', JSON.stringify(makeCreature({ name: '  ' }))],
    ['a short hex colour', JSON.stringify(makeCreature({ color: '#abc' }))],
    ['a named colour', JSON.stringify(makeCreature({ color: 'red' }))],
    ['a shape of the wrong form', JSON.stringify(makeCreature({ shape: '50%' }))],
    ['a missing field', JSON.stringify({ name: 'Pip', color: '#a8d8c9' })],
  ])('rejects %s', (_label, raw) => {
    expect(parseCreatureContent(raw)).toBeNull()
  })
})

describe('chooseCreature', () => {
  it('picks the first free name in a slug-seeded rotation and a stable shape', () => {
    const first = chooseCreature({ slug: 'task-a', parent: null, takenNames: new Set(), takenColors: new Set() })
    expect(CREATURE_NAMES).toContain(first.name)
    expect(first.shape).toBe(seededShape('task-a'))
    expect(chooseCreature({ slug: 'task-a', parent: null, takenNames: new Set(), takenColors: new Set() })).toEqual(first)
  })

  it('skips names that are taken', () => {
    const first = chooseCreature({ slug: 'task-a', parent: null, takenNames: new Set(), takenColors: new Set() })
    const second = chooseCreature({ slug: 'task-a', parent: null, takenNames: new Set([first.name]), takenColors: new Set() })
    expect(second.name).not.toBe(first.name)
    expect(CREATURE_NAMES).toContain(second.name)
  })

  it('numbers the seeded name once every name is taken', () => {
    const creature = chooseCreature({ slug: 'task-a', parent: null, takenNames: new Set(CREATURE_NAMES), takenColors: new Set() })
    expect(creature.name).toMatch(/^[A-Z][a-z]+\d+$/)
    expect(CREATURE_NAMES).toContain(creature.name.replace(/\d+$/, ''))
  })

  it('never repeats a numbered name either', () => {
    const taken = new Set(CREATURE_NAMES)
    const first = chooseCreature({ slug: 'task-a', parent: null, takenNames: taken, takenColors: new Set() })
    taken.add(first.name)
    expect(chooseCreature({ slug: 'task-a', parent: null, takenNames: taken, takenColors: new Set() }).name).not.toBe(first.name)
  })

  it('takes the first palette colour no active task uses', () => {
    const creature = chooseCreature({ slug: 'task-a', parent: null, takenNames: new Set(), takenColors: new Set([CREATURE_COLORS[0]]) })
    expect(creature.color).toBe(CREATURE_COLORS[1])
  })

  it('falls back to a palette colour when all are used', () => {
    const creature = chooseCreature({ slug: 'task-a', parent: null, takenNames: new Set(), takenColors: new Set(CREATURE_COLORS) })
    expect(CREATURE_COLORS).toContain(creature.color)
  })

  it('shades a subtask from its parent: lighter for an even milestone, darker for an odd one', () => {
    const even = chooseCreature({ slug: 'plan-m0', parent: PARENT, takenNames: new Set(['Pip']), takenColors: new Set() })
    const odd = chooseCreature({ slug: 'plan-m1', parent: PARENT, takenNames: new Set(['Pip']), takenColors: new Set() })
    expect(even.color).toBe(shadeColor(PARENT.color, 0.18))
    expect(odd.color).toBe(shadeColor(PARENT.color, -0.18))
    expect(even.name).not.toBe('Pip')
  })

  it('treats a parent as no parent when the slug has no milestone number', () => {
    const creature = chooseCreature({ slug: 'plain-task', parent: PARENT, takenNames: new Set(), takenColors: new Set() })
    expect(CREATURE_COLORS).toContain(creature.color)
  })
})

describe('assignMissingCreatures', () => {
  let tasksDir: string
  const log = vi.fn()

  beforeEach(async () => {
    tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-creature-test-'))
    log.mockReset()
  })
  afterEach(async () => {
    await fs.rm(tasksDir, { recursive: true, force: true })
  })

  async function makeTaskDir(slug: string) {
    await fs.mkdir(path.join(tasksDir, slug), { recursive: true })
  }
  const creatureFile = (slug: string) => path.join(tasksDir, slug, 'CREATURE')

  it('writes a CREATURE file for a task without one and puts it on the task', async () => {
    await makeTaskDir('task-a')
    const tasks = [makeTaskStub('task-a')]
    await assignMissingCreatures(tasks, tasksDir, log)
    expect(tasks[0].creature).not.toBeNull()
    expect(parseCreatureContent(await fs.readFile(creatureFile('task-a'), 'utf-8'))).toEqual(tasks[0].creature)
    expect(log).not.toHaveBeenCalled()
  })

  it('leaves a task that already has a creature, and a done task, alone', async () => {
    await makeTaskDir('has-one')
    await makeTaskDir('is-done')
    const tasks = [makeTaskStub('has-one', { creature: PARENT }), makeTaskStub('is-done', { status: 'done' })]
    await assignMissingCreatures(tasks, tasksDir, log)
    expect(tasks[0].creature).toEqual(PARENT)
    expect(tasks[1].creature).toBeNull()
    await expect(fs.access(creatureFile('has-one'))).rejects.toThrow()
    await expect(fs.access(creatureFile('is-done'))).rejects.toThrow()
  })

  it('gives every new task a unique name and colour', async () => {
    const slugs = ['t-1', 't-2', 't-3', 't-4']
    for (const slug of slugs) await makeTaskDir(slug)
    const tasks = slugs.map((slug) => makeTaskStub(slug))
    await assignMissingCreatures(tasks, tasksDir, log)
    expect(new Set(tasks.map((t) => t.creature!.name)).size).toBe(slugs.length)
    expect(new Set(tasks.map((t) => t.creature!.color)).size).toBe(slugs.length)
  })

  it('avoids names already used by existing active tasks', async () => {
    await makeTaskDir('new-one')
    const seeded = chooseCreature({ slug: 'new-one', parent: null, takenNames: new Set(), takenColors: new Set() })
    const tasks = [makeTaskStub('existing', { creature: makeCreature({ name: seeded.name }) }), makeTaskStub('new-one')]
    await assignMissingCreatures(tasks, tasksDir, log)
    expect(tasks[1].creature!.name).not.toBe(seeded.name)
  })

  it('assigns a parent before its milestone child, so the child shades the parent colour', async () => {
    await makeTaskDir('plan')
    await makeTaskDir('plan-m0')
    const tasks = [makeTaskStub('plan-m0', { projectBase: 'plan' }), makeTaskStub('plan')]
    await assignMissingCreatures(tasks, tasksDir, log)
    expect(tasks[0].creature!.color).toBe(shadeColor(tasks[1].creature!.color, 0.18))
  })

  it('uses the file another pass wrote first when the exclusive write hits EEXIST', async () => {
    await makeTaskDir('raced')
    await fs.writeFile(creatureFile('raced'), JSON.stringify(PARENT))
    const tasks = [makeTaskStub('raced')]
    await assignMissingCreatures(tasks, tasksDir, log)
    expect(tasks[0].creature).toEqual(PARENT)
    expect(JSON.parse(await fs.readFile(creatureFile('raced'), 'utf-8'))).toEqual(PARENT)
  })

  it('keeps an invalid CREATURE file found on EEXIST untouched and leaves the creature null, leaving the logging to parseTask', async () => {
    await makeTaskDir('broken')
    await fs.writeFile(creatureFile('broken'), 'not json')
    const tasks = [makeTaskStub('broken')]
    await assignMissingCreatures(tasks, tasksDir, log)
    expect(tasks[0].creature).toBeNull()
    expect(await fs.readFile(creatureFile('broken'), 'utf-8')).toBe('not json')
    expect(log).not.toHaveBeenCalled()
  })

  it('skips a task whose directory vanished mid-refresh (ENOENT) without logging', async () => {
    const tasks = [makeTaskStub('gone')]
    await assignMissingCreatures(tasks, tasksDir, log)
    expect(tasks[0].creature).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  it('logs a write failure and still uses the creature for this snapshot', async () => {
    await makeTaskDir('unwritable')
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    const writeSpy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(failure)
    const tasks = [makeTaskStub('unwritable')]
    await assignMissingCreatures(tasks, tasksDir, log)
    writeSpy.mockRestore()
    expect(tasks[0].creature).not.toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[creature] could not store CREATURE for unwritable'), failure)
  })

  it('logs when every name is in use and still assigns a numbered one', async () => {
    await makeTaskDir('late')
    const used = CREATURE_NAMES.map((name, index) => makeTaskStub(`used-${index}`, { creature: makeCreature({ name }) }))
    const tasks = [...used, makeTaskStub('late')]
    await assignMissingCreatures(tasks, tasksDir, log)
    expect(tasks[tasks.length - 1].creature!.name).toMatch(/\d+$/)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[creature] every name is in use'))
  })

  it('serialises overlapping runs so two refreshes cannot hand one name to two tasks', async () => {
    await makeTaskDir('x-1')
    await makeTaskDir('x-2')
    const first = [makeTaskStub('x-1'), makeTaskStub('x-2')]
    const second = [makeTaskStub('x-1'), makeTaskStub('x-2')]
    await Promise.all([assignMissingCreatures(first, tasksDir, log), assignMissingCreatures(second, tasksDir, log)])
    expect(second.map((t) => t.creature)).toEqual(first.map((t) => t.creature))
    expect(new Set(first.map((t) => t.creature!.name)).size).toBe(2)
  })
})
