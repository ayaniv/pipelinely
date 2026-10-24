import fs from 'node:fs/promises'
import path from 'node:path'
import type { Task, TaskCreature } from './types.js'

// Task creatures: a permanent per-task identity {name, color, shape}, picked
// once by the server and stored in the task's own CREATURE file. After that
// it is only ever read, so a change of stage, status or tab can't change it.

// Soft pastels, including the design prototype's ten.
export const CREATURE_COLORS = [
  '#a8d8c9', '#f4c9a8', '#c9b8e8', '#f2b8c6', '#b8d4f0', '#e8dc9c',
  '#b8e0a8', '#f0b8a0', '#a8d0d8', '#d8b8d8', '#c8d8a0', '#f0cfa0',
]

// Enough single words to name every task on a busy board (and the fixture
// tree, which holds about 75 active tasks) without numbering.
export const CREATURE_NAMES = [
  'Pip', 'Juno', 'Kiko', 'Moss', 'Otto', 'Wren', 'Lumi', 'Nell', 'Tavi', 'Bram',
  'Fern', 'Dot', 'Milo', 'Zuzu', 'Poppy', 'Rue', 'Sunny', 'Tilly', 'Basil', 'Coco',
  'Dill', 'Elio', 'Figgy', 'Gus', 'Hazel', 'Iggy', 'Jinx', 'Kit', 'Lark', 'Mabel',
  'Nico', 'Olive', 'Pebble', 'Quill', 'Remy', 'Sage', 'Tofu', 'Uma', 'Vera', 'Waffle',
  'Yuki', 'Ziggy', 'Biscuit', 'Clover', 'Dumpling', 'Ember', 'Fable', 'Ginger', 'Hugo', 'Indy',
  'Jojo', 'Koko', 'Luna', 'Mochi', 'Nori', 'Ollie', 'Pixel', 'Quincy', 'Rosie', 'Sprout',
  'Teddy', 'Ume', 'Violet', 'Willow', 'Xena', 'Yoyo', 'Zola', 'Acorn', 'Bean', 'Cricket',
  'Daisy', 'Echo', 'Fig', 'Gizmo', 'Honey', 'Ivy', 'Jam', 'Kiwi', 'Lemon', 'Mango',
  'Nutmeg', 'Opal', 'Pickle', 'Quartz', 'Rocket', 'Sesame', 'Taro', 'Umber', 'Velvet', 'Walnut',
  'Yam', 'Zest', 'Alder', 'Birch', 'Cedar', 'Dune', 'Elm', 'Flint',
]

const SHAPE_VALUE_MIN = 30
const SHAPE_VALUE_RANGE = 41   // 30..70 inclusive
const SHAPE_VALUE_COUNT = 8
const SUBTASK_SHADE_AMOUNT = 0.18
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i
const SHAPE_RE = /^(\d{2}% ){3}\d{2}% \/ (\d{2}% ){3}\d{2}%$/
const MILESTONE_NUMBER_RE = /-m(\d+)$/

// FNV-1a: a small, stable string hash so a slug always seeds the same picks.
function hashSlug(slug: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < slug.length; i++) {
    hash ^= slug.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// mulberry32: a seedable PRNG, so the shape is reproducible from the slug.
function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seededShape(slug: string): string {
  const random = mulberry32(hashSlug(slug))
  const values = Array.from({ length: SHAPE_VALUE_COUNT }, () => SHAPE_VALUE_MIN + Math.floor(random() * SHAPE_VALUE_RANGE))
  const percents = values.map((value) => `${value}%`)
  return `${percents.slice(0, 4).join(' ')} / ${percents.slice(4).join(' ')}`
}

// Mixes a #rrggbb colour toward white (amount > 0) or black (amount < 0).
// Mixing with white or black keeps the hue, so a subtask reads as its
// parent's colour, just lighter or darker.
export function shadeColor(hex: string, amount: number): string {
  const target = amount >= 0 ? 255 : 0
  const weight = Math.min(1, Math.abs(amount))
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16))
  const mixed = channels.map((value) => Math.round(value + (target - value) * weight))
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

export function parseCreatureContent(raw: string): TaskCreature | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const { name, color, shape } = parsed as Record<string, unknown>
    if (typeof name !== 'string' || name.trim() === '') return null
    if (typeof color !== 'string' || !HEX_COLOR_RE.test(color)) return null
    if (typeof shape !== 'string' || !SHAPE_RE.test(shape)) return null
    return { name, color, shape }
  } catch {
    return null
  }
}

export interface ChooseCreatureInput {
  slug: string
  // The creature of this task's milestone parent, when it has one.
  parent: TaskCreature | null
  takenNames: ReadonlySet<string>
  takenColors: ReadonlySet<string>
}

function pickName(slug: string, takenNames: ReadonlySet<string>): string {
  const start = hashSlug(slug) % CREATURE_NAMES.length
  for (let offset = 0; offset < CREATURE_NAMES.length; offset++) {
    const name = CREATURE_NAMES[(start + offset) % CREATURE_NAMES.length]
    if (!takenNames.has(name)) return name
  }
  // Every name is in use: number the seeded one rather than repeat it.
  const seeded = CREATURE_NAMES[start]
  let suffix = 2
  while (takenNames.has(`${seeded}${suffix}`)) suffix++
  return `${seeded}${suffix}`
}

function pickColor({ slug, parent, takenColors }: ChooseCreatureInput): string {
  const milestone = MILESTONE_NUMBER_RE.exec(slug)
  if (parent && milestone) {
    const isEven = Number(milestone[1]) % 2 === 0
    return shadeColor(parent.color, isEven ? SUBTASK_SHADE_AMOUNT : -SUBTASK_SHADE_AMOUNT)
  }
  const free = CREATURE_COLORS.find((color) => !takenColors.has(color))
  return free ?? CREATURE_COLORS[hashSlug(slug) % CREATURE_COLORS.length]
}

export function chooseCreature(input: ChooseCreatureInput): TaskCreature {
  return {
    name: pickName(input.slug, input.takenNames),
    color: pickColor(input),
    shape: seededShape(input.slug),
  }
}

type Log = (message: string, ...details: unknown[]) => void

async function readStoredCreature(file: string, slug: string, log: Log): Promise<TaskCreature | null> {
  try {
    // An invalid file is already logged by parseTask on every refresh; logging
    // it here too would double the noise for one bad hand edit.
    return parseCreatureContent(await fs.readFile(file, 'utf-8'))
  } catch (err) {
    log(`[creature] could not read CREATURE for ${slug}`, err)
    return null
  }
}

// Writes the chosen creature exclusively ('wx'), so a concurrent pass can
// never overwrite one that already exists. Returns the creature the task
// should use, or null when the task should go without one this refresh.
async function storeCreature(file: string, slug: string, chosen: TaskCreature, log: Log): Promise<TaskCreature | null> {
  try {
    await fs.writeFile(file, JSON.stringify(chosen), { flag: 'wx' })
    return chosen
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // Another pass (or a hand edit) got there first: that file wins.
    if (code === 'EEXIST') return readStoredCreature(file, slug, log)
    // The task directory was removed mid-refresh.
    if (code === 'ENOENT') return null
    // Use the creature for this snapshot only; the next refresh retries.
    log(`[creature] could not store CREATURE for ${slug}`, err)
    return chosen
  }
}

function isActive(task: Task): boolean {
  return task.status !== 'done'
}

// Parents come first, then by slug, so a child always sees its parent's colour.
function assignmentOrder(tasks: Task[]): Task[] {
  return tasks
    .filter((task) => isActive(task) && task.creature === null)
    .sort((a, b) => Number(a.projectBase !== undefined) - Number(b.projectBase !== undefined) || a.slug.localeCompare(b.slug))
}

async function assignOnce(tasks: Task[], tasksDir: string, log: Log): Promise<void> {
  const active = tasks.filter(isActive)
  const takenNames = new Set<string>()
  const takenColors = new Set<string>()
  for (const task of active) {
    if (task.creature) {
      takenNames.add(task.creature.name)
      takenColors.add(task.creature.color)
    }
  }
  const creatureBySlug = new Map(tasks.map((task) => [task.slug, task.creature]))

  for (const task of assignmentOrder(tasks)) {
    const parent = task.projectBase !== undefined ? creatureBySlug.get(task.projectBase) ?? null : null
    const chosen = chooseCreature({ slug: task.slug, parent, takenNames, takenColors })
    if (!CREATURE_NAMES.includes(chosen.name)) log(`[creature] every name is in use; numbering ${task.slug}'s as ${chosen.name}`)
    const stored = await storeCreature(path.join(tasksDir, task.slug, 'CREATURE'), task.slug, chosen, log)
    task.creature = stored
    creatureBySlug.set(task.slug, stored)
    if (stored) {
      takenNames.add(stored.name)
      takenColors.add(stored.color)
    }
  }
}

// One chain for the whole process: two overlapping refreshes run their
// assignments one after the other, so the second finds the first's files and
// can't hand the same name to two new tasks.
let assignmentQueue: Promise<void> = Promise.resolve()

// Gives every active task that has no creature one, mutating `tasks` in place.
// Never throws: a refresh must not fail because a creature could not be stored.
export function assignMissingCreatures(tasks: Task[], tasksDir: string, log: Log): Promise<void> {
  const run = assignmentQueue.then(() => assignOnce(tasks, tasksDir, log))
  assignmentQueue = run.catch((err) => log('[creature] assignment failed', err))
  return assignmentQueue
}
