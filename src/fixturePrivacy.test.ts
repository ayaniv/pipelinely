import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__')

// Built from parts so this file does not itself name the private repo it guards against.
const PRIVATE_REPO_NAME = ['pipelinely', 'marketing'].join('-')

// Fixtures ship in the public product, so they must never carry content copied from private documents.
const PRIVATE_MARKERS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'private repo name', pattern: new RegExp(PRIVATE_REPO_NAME) },
  { name: 'commit SHA', pattern: /commit\s+[0-9a-f]{7,40}\b/i },
  { name: 'absolute /Users/ path', pattern: /\/Users\// },
]

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? listFiles(full) : [full]
  }))
  return nested.flat()
}

async function findPrivateMarkers(dir: string): Promise<string[]> {
  const findings: string[] = []
  for (const file of await listFiles(dir)) {
    const content = await fs.readFile(file, 'utf-8')
    for (const { name, pattern } of PRIVATE_MARKERS) {
      if (pattern.test(content)) findings.push(`${path.relative(dir, file)}: ${name}`)
    }
  }
  return findings
}

describe('fixture privacy guard', () => {
  let tmpFixtures: string

  beforeEach(async () => {
    tmpFixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'fixture-privacy-'))
  })

  afterEach(async () => {
    await fs.rm(tmpFixtures, { recursive: true, force: true })
  })

  it('finds no private markers in src/__fixtures__', async () => {
    expect(await findPrivateMarkers(FIXTURES)).toEqual([])
  })

  it.each([
    ['the private repo name', `see ${PRIVATE_REPO_NAME} for details`, 'private repo name'],
    ['a 40-hex commit SHA', 'fixed in commit 0123456789abcdef0123456789abcdef01234567', 'commit SHA'],
    ['a 7-hex commit SHA', 'fixed in commit 0123abc.', 'commit SHA'],
    ['a 12-hex abbreviated commit SHA', 'fixed in commit 0123456789ab', 'commit SHA'],
    ['a /Users/ path', 'cat /Users/someone/notes.md', 'absolute /Users/ path'],
  ])('fails on %s and names the file', async (_label, content, marker) => {
    await fs.mkdir(path.join(tmpFixtures, 'nested'))
    await fs.writeFile(path.join(tmpFixtures, 'nested', 'leaky.md'), content)
    await fs.writeFile(path.join(tmpFixtures, 'clean.md'), '# Nothing private here\n')
    expect(await findPrivateMarkers(tmpFixtures)).toEqual([`${path.join('nested', 'leaky.md')}: ${marker}`])
  })

  it('does not flag a bare hex word without the word commit', async () => {
    await fs.writeFile(path.join(tmpFixtures, 'ok.md'), 'the id deadbeef is fine, and so is a commit message\n')
    expect(await findPrivateMarkers(tmpFixtures)).toEqual([])
  })
})
