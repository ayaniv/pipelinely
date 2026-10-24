import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllTasks } from './taskParser.js'

// The `ui` e2e server runs against the checked-in fixture tree. A missing
// CREATURE file would be written by the server during a run and dirty the
// repo, so every fixture task that is not done carries a committed one.
const FIXTURE_TASKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'fixtures', 'tasks')

describe('fixture task creatures', () => {
  it('every fixture task that is not done has a committed, valid CREATURE', async () => {
    const tasks = (await parseAllTasks(FIXTURE_TASKS_DIR)).filter((task) => task.status !== 'done')
    expect(tasks.length).toBeGreaterThan(0)
    const missing = tasks.filter((task) => task.creature === null).map((task) => task.slug)
    expect(missing, 'run the creature assigner over e2e/fixtures/tasks and commit the CREATURE files').toEqual([])
  })

  it('names are unique among the fixture tasks that are not done', async () => {
    const names = (await parseAllTasks(FIXTURE_TASKS_DIR)).filter((task) => task.status !== 'done').map((task) => task.creature?.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
