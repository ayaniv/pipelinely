import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTask } from './taskParser.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__')

describe('parseTask resultDoc', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-result-doc-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function makeTaskDir(files: Record<string, string>): Promise<string> {
    const dir = path.join(tmpDir, 'research-task')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'STATUS'), 'waiting: audit ready for developer review')
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content)
    return dir
  }

  it('is null for a task with no deliverable', async () => {
    expect((await parseTask(await makeTaskDir({})))?.resultDoc).toBeNull()
  })

  it.each([
    ['AUDIT.md', 'sample-audit.md'],
    ['DESIGN.md', 'sample-design.md'],
  ])('exposes a sample %s as metadata only, never the markdown', async (name, fixture) => {
    const body = await fs.readFile(path.join(FIXTURES, fixture), 'utf-8')
    const task = await parseTask(await makeTaskDir({ [name]: body }))
    expect(task?.resultDoc).toEqual({ file: name, isTruncated: false, totalBytes: Buffer.byteLength(body), mtimeMs: expect.any(Number) })
    expect(JSON.stringify(task)).not.toContain(body.slice(0, 200))
  })

  it('uses a research task\'s TASK.md "## Result" section when no file exists', async () => {
    const task = await parseTask(await makeTaskDir({ 'TASK.md': '# T\n\n## Mode: investigate\n\n## Result\nDone: see above.\n' }))
    expect(task?.resultDoc).toMatchObject({ file: 'TASK.md' })
  })

  it('ignores the "## Result" PR notes of a finished implement task', async () => {
    const task = await parseTask(await makeTaskDir({ 'TASK.md': '# T\n\n## Mode: implement\n\n## Result\nPR: https://github.com/x/y/pull/1\n' }))
    expect(task?.resultDoc).toBeNull()
  })
})
