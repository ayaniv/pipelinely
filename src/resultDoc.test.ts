import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants as fsConstants } from 'node:fs'
import { MAX_RESULT_DOC_BYTES, findResultDoc, toResultDocMeta } from './resultDoc.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__')

let taskDir: string

beforeEach(async () => {
  taskDir = await fs.mkdtemp(path.join(os.tmpdir(), 'result-doc-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(taskDir, { recursive: true, force: true })
})

const write = (name: string, body: string) => fs.writeFile(path.join(taskDir, name), body)

describe('findResultDoc discovery order', () => {
  it('returns null when the task dir has no deliverable', async () => {
    expect(await findResultDoc(taskDir, null, 'investigate')).toBeNull()
  })

  it('prefers RESULT.md over every other candidate', async () => {
    await Promise.all([write('RESULT.md', '# result'), write('AUDIT.md', '# audit'), write('DESIGN.md', '# design'), write('FINDINGS.md', '# findings')])
    expect(await findResultDoc(taskDir, '## Result\nfrom task', 'investigate')).toMatchObject({ file: 'RESULT.md', markdown: '# result' })
  })

  it('prefers AUDIT.md over DESIGN.md, FINDINGS.md and the TASK.md section', async () => {
    await Promise.all([write('AUDIT.md', '# audit'), write('DESIGN.md', '# design'), write('FINDINGS.md', '# findings')])
    expect(await findResultDoc(taskDir, '## Result\nx', 'investigate')).toMatchObject({ file: 'AUDIT.md' })
  })

  it('prefers DESIGN.md over FINDINGS.md', async () => {
    await Promise.all([write('DESIGN.md', '# design'), write('FINDINGS.md', '# findings')])
    expect(await findResultDoc(taskDir, null, 'investigate')).toMatchObject({ file: 'DESIGN.md' })
  })

  it('prefers FINDINGS.md over the TASK.md Result section', async () => {
    await write('FINDINGS.md', '# findings')
    expect(await findResultDoc(taskDir, '## Result\nx', 'investigate')).toMatchObject({ file: 'FINDINGS.md' })
  })

  it('falls back to the TASK.md "## Result" section, up to the next h2', async () => {
    const taskMd = '# T\n\n## Steps\n1. a\n\n## Result\nThe answer is 42.\n\n| a | b |\n|---|---|\n\n## Output\nelsewhere'
    const doc = await findResultDoc(taskDir, taskMd, 'investigate')
    expect(doc).toMatchObject({ file: 'TASK.md', isTruncated: false })
    expect(doc?.markdown).toContain('The answer is 42.')
    expect(doc?.markdown).not.toContain('elsewhere')
  })

  it('ignores an empty TASK.md "## Result" heading', async () => {
    expect(await findResultDoc(taskDir, '## Result\n\n## Output\nx', 'investigate')).toBeNull()
  })

  it('skips an empty higher-priority file and uses the next one', async () => {
    await Promise.all([write('RESULT.md', '   \n'), write('AUDIT.md', '# audit')])
    expect(await findResultDoc(taskDir, null, 'investigate')).toMatchObject({ file: 'AUDIT.md' })
  })
})

describe('findResultDoc TASK.md fallback gating', () => {
  const taskMd = '# T\n\n## Result\nPR: https://github.com/x/y/pull/1\nNotes for the reviewer.\n'

  it.each(['investigate', 'verify'] as const)('reads the section for a %s task', async (mode) => {
    expect(await findResultDoc(taskDir, taskMd, mode)).toMatchObject({ file: 'TASK.md' })
  })

  it.each(['implement', ''] as const)('ignores the section of a %j task, so finished PR notes get no Result tab', async (mode) => {
    expect(await findResultDoc(taskDir, taskMd, mode)).toBeNull()
  })

  it('still reads a real deliverable file whatever the mode', async () => {
    await write('RESULT.md', '# r')
    expect(await findResultDoc(taskDir, taskMd, 'implement')).toMatchObject({ file: 'RESULT.md' })
  })
})

describe('findResultDoc TASK.md section boundaries', () => {
  const find = (taskMd: string) => findResultDoc(taskDir, taskMd, 'investigate')

  it('ignores a "## Result" line inside a fenced code block', async () => {
    expect(await find('# T\n\n```md\n## Result\nnot real\n```\n')).toBeNull()
  })

  it('is not cut short by a "## " line inside a fenced code block within the section', async () => {
    const doc = await find('## Result\nbefore\n```md\n## Example heading\n```\nafter\n\n## Output\nelsewhere')
    expect(doc?.markdown).toContain('## Example heading')
    expect(doc?.markdown).toContain('after')
    expect(doc?.markdown).not.toContain('elsewhere')
  })

  it('keeps ### subsections', async () => {
    expect((await find('## Result\n### Sub\ntext\n## Next'))?.markdown).toContain('### Sub')
  })
})

describe('findResultDoc mtimeMs', () => {
  it("carries the file's own mtimeMs, so a same-size edit can still be told apart", async () => {
    await write('RESULT.md', '# doc')
    const stat = await fs.stat(path.join(taskDir, 'RESULT.md'))
    const doc = await findResultDoc(taskDir, null, 'investigate')
    expect(doc?.mtimeMs).toBe(stat.mtimeMs)
  })

  it('changes mtimeMs on a same-byte-length rewrite (a word swapped for one the same length)', async () => {
    await write('RESULT.md', '# The cat sat')
    const first = await findResultDoc(taskDir, null, 'investigate')
    // Force the mtime forward regardless of filesystem timestamp granularity.
    const bumped = new Date((await fs.stat(path.join(taskDir, 'RESULT.md'))).mtimeMs + 5000)
    await fs.utimes(path.join(taskDir, 'RESULT.md'), bumped, bumped)
    await fs.writeFile(path.join(taskDir, 'RESULT.md'), '# The dog ran')
    await fs.utimes(path.join(taskDir, 'RESULT.md'), bumped, bumped)
    const second = await findResultDoc(taskDir, null, 'investigate')
    expect(second?.totalBytes).toBe(first?.totalBytes)
    expect(second?.mtimeMs).not.toBe(first?.mtimeMs)
    expect(second?.markdown).toContain('dog ran')
  })
})

describe('findResultDoc read caching', () => {
  it('does not re-read a file whose mtime and size are unchanged since the last read', async () => {
    await write('RESULT.md', '# doc')
    const openSpy = vi.spyOn(fs, 'open')
    await findResultDoc(taskDir, null, 'investigate')
    await findResultDoc(taskDir, null, 'investigate')
    expect(openSpy).toHaveBeenCalledTimes(1)
    openSpy.mockRestore()
  })

  it('re-reads once the file changes size', async () => {
    await write('RESULT.md', '# v1')
    const first = await findResultDoc(taskDir, null, 'investigate')
    expect(first?.markdown).toContain('v1')

    await write('RESULT.md', '# v2, a fair bit longer than v1')
    const second = await findResultDoc(taskDir, null, 'investigate')
    expect(second?.markdown).toContain('v2')
    expect(second?.totalBytes).not.toBe(first?.totalBytes)
  })
})

describe('findResultDoc failure and size handling', () => {
  it('returns null and logs the reason when a candidate is unreadable', async () => {
    // A directory named RESULT.md makes readFile throw EISDIR, not ENOENT.
    await fs.mkdir(path.join(taskDir, 'RESULT.md'))
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await findResultDoc(taskDir, null, 'investigate')).toBeNull()
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('RESULT.md'), expect.anything())
  })

  it('keeps a document under the cap whole', async () => {
    await write('RESULT.md', 'x'.repeat(1000))
    expect(await findResultDoc(taskDir, null, 'investigate')).toMatchObject({ isTruncated: false, totalBytes: 1000 })
  })

  it('caps an oversized document and says so in the field', async () => {
    await write('RESULT.md', 'a'.repeat(MAX_RESULT_DOC_BYTES + 5000))
    const doc = await findResultDoc(taskDir, null, 'investigate')
    expect(doc?.isTruncated).toBe(true)
    expect(doc?.totalBytes).toBe(MAX_RESULT_DOC_BYTES + 5000)
    expect(Buffer.byteLength(doc!.markdown)).toBeLessThanOrEqual(MAX_RESULT_DOC_BYTES)
  })

  it('does not split a multi-byte character at the cap', async () => {
    await write('RESULT.md', 'é'.repeat(MAX_RESULT_DOC_BYTES))
    const doc = await findResultDoc(taskDir, null, 'investigate')
    expect(doc?.markdown).not.toContain('�')
  })
})

describe('findResultDoc file safety', () => {
  let outsideDir: string

  beforeEach(async () => {
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'result-doc-outside-'))
  })

  afterEach(async () => {
    await fs.rm(outsideDir, { recursive: true, force: true })
  })

  it('refuses a RESULT.md symlinked to a file outside the task dir, and logs why', async () => {
    const secret = path.join(outsideDir, 'secret.txt')
    await fs.writeFile(secret, 'top secret')
    await fs.symlink(secret, path.join(taskDir, 'RESULT.md'))
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await findResultDoc(taskDir, null, 'investigate')).toBeNull()
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('RESULT.md'), expect.anything())
  })

  it('refuses a symlink even when it points inside the task dir', async () => {
    await write('real.md', '# inside')
    await fs.symlink(path.join(taskDir, 'real.md'), path.join(taskDir, 'RESULT.md'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await findResultDoc(taskDir, null, 'investigate')).toBeNull()
  })

  it('falls through a refused candidate to the next real file', async () => {
    await fs.symlink(path.join(outsideDir, 'nowhere'), path.join(taskDir, 'RESULT.md'))
    await write('AUDIT.md', '# audit')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await findResultDoc(taskDir, null, 'investigate')).toMatchObject({ file: 'AUDIT.md' })
  })

  it('refuses a candidate whose real path escapes the task dir through a symlinked parent', async () => {
    await fs.writeFile(path.join(outsideDir, 'RESULT.md'), '# elsewhere')
    const linkedDir = path.join(os.tmpdir(), `result-doc-link-${Date.now()}`)
    await fs.symlink(outsideDir, linkedDir)
    try {
      // The dir handed in is itself a symlink: its files are still "inside" it.
      expect(await findResultDoc(linkedDir, null, 'investigate')).toMatchObject({ file: 'RESULT.md' })
    } finally {
      await fs.rm(linkedDir, { force: true })
    }
  })

  it('refuses a candidate that becomes non-regular after opening (a TOCTOU race between lstat and open), without hanging or reading it', async () => {
    await write('RESULT.md', '# ok')
    const fakeHandle = {
      stat: vi.fn().mockResolvedValue({ isFile: () => false, size: 0 }),
      read: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const openSpy = vi.spyOn(fs, 'open').mockResolvedValueOnce(fakeHandle as never)
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await findResultDoc(taskDir, null, 'investigate')).toBeNull()
    expect(fakeHandle.read).not.toHaveBeenCalled()
    expect(fakeHandle.close).toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('RESULT.md'), expect.anything())
    openSpy.mockRestore()
  })

  it('opens with O_NONBLOCK so a FIFO swapped in for the file cannot hang the read', async () => {
    const openSpy = vi.spyOn(fs, 'open')
    await write('RESULT.md', '# ok')
    await findResultDoc(taskDir, null, 'investigate')
    expect(openSpy.mock.calls[0][1]).toEqual(expect.any(Number))
    const flags = openSpy.mock.calls[0][1] as number
    expect(flags & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK)
    openSpy.mockRestore()
  })

  it('caps a multi-gigabyte file without reading it whole', async () => {
    const handle = await fs.open(path.join(taskDir, 'RESULT.md'), 'w')
    await handle.truncate(3 * 1024 * 1024 * 1024) // sparse: costs no disk
    await handle.close()
    const doc = await findResultDoc(taskDir, null, 'investigate')
    expect(doc).toMatchObject({ isTruncated: true, totalBytes: 3 * 1024 * 1024 * 1024 })
    expect(Buffer.byteLength(doc!.markdown)).toBeLessThanOrEqual(MAX_RESULT_DOC_BYTES)
  })
})

describe('toResultDocMeta', () => {
  it('drops the markdown and keeps the rest', () => {
    expect(toResultDocMeta({ file: 'AUDIT.md', markdown: '# x', isTruncated: false, totalBytes: 3, mtimeMs: 123 })).toEqual({ file: 'AUDIT.md', isTruncated: false, totalBytes: 3, mtimeMs: 123 })
  })

  it('passes null through', () => {
    expect(toResultDocMeta(null)).toBeNull()
  })
})

describe('sample deliverables', () => {
  it.each([
    ['AUDIT.md', 'sample-audit.md'],
    ['DESIGN.md', 'sample-design.md'],
  ])('discovers %s from a sample document with no renaming', async (name, fixture) => {
    const body = await fs.readFile(path.join(FIXTURES, fixture), 'utf-8')
    await write(name, body)
    const doc = await findResultDoc(taskDir, null, 'investigate')
    expect(doc).toMatchObject({ file: name, isTruncated: false })
    expect(doc?.markdown).toBe(body)
  })
})
