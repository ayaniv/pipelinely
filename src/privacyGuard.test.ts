import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseUrlAllowlist,
  findOutboundUrlViolations,
  listShippedFiles,
  scanShippedTree,
  URL_ALLOWLIST_RELATIVE_PATH,
} from './privacyGuard.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

// oss/ is publish tooling that never ships, so the published copy of this
// test has no oss/lib.sh to read the publish list from; the tree-scanning
// suites only make sense in the private repo.
const hasPublishTooling = fs.existsSync(path.join(REPO_ROOT, 'oss/lib.sh'))

// Assembled at runtime so this (shipped) test file never contains a literal
// off-allowlist URL for the scanner to trip over.
const stray = (host: string, rest = '/x'): string => `${'https'}://${host}${rest}`

const ALLOWLIST_TEXT = [
  'host github.com   # source links',
  'host localhost    # loopback',
  'file package-lock.json  # registry URLs',
].join('\n')

describe('parseUrlAllowlist', () => {
  it('reads host and file entries, ignoring blanks and comments', () => {
    const allowlist = parseUrlAllowlist(`# header\n\n${ALLOWLIST_TEXT}\n`)
    expect(allowlist.hosts).toEqual(['github.com', 'localhost'])
    expect(allowlist.files).toEqual(['package-lock.json'])
  })

  it('rejects an entry with no reason comment', () => {
    expect(() => parseUrlAllowlist('host github.com')).toThrow(/:1:.*reason/i)
  })

  it('rejects an unknown entry kind', () => {
    expect(() => parseUrlAllowlist('url github.com # nope')).toThrow(/:1:.*unknown kind/i)
  })
})

describe('findOutboundUrlViolations', () => {
  const allowlist = parseUrlAllowlist(ALLOWLIST_TEXT)

  it('passes allow-listed hosts, including subdomains', () => {
    const content = `see ${stray('github.com', '/a/b')} and ${stray('raw.github.com')} and http://localhost:3030`
    expect(findOutboundUrlViolations([{ path: 'a.md', content }], allowlist)).toEqual([])
  })

  it('does not treat a lookalike host as a subdomain', () => {
    const [violation] = findOutboundUrlViolations(
      [{ path: 'a.md', content: stray('notgithub.com') }],
      allowlist,
    )
    expect(violation.host).toBe('notgithub.com')
  })

  it('reports file, 1-based line and host of an off-allowlist URL', () => {
    const content = `line one\nfetch("${stray('tracker.example.net', '/p')}")\n`
    expect(findOutboundUrlViolations([{ path: 'src/a.ts', content }], allowlist)).toEqual([
      { file: 'src/a.ts', line: 2, host: 'tracker.example.net', url: stray('tracker.example.net', '/p') },
    ])
  })

  it('skips files exempted by a file entry', () => {
    const content = stray('registry.npmjs.org')
    expect(findOutboundUrlViolations([{ path: 'package-lock.json', content }], allowlist)).toEqual([])
  })

  it('ignores dotless hosts, which cannot be a public destination', () => {
    expect(findOutboundUrlViolations([{ path: 'a.ts', content: 'http://x/1 https://intranet' }], allowlist)).toEqual([])
  })
})

describe.skipIf(!hasPublishTooling)('listShippedFiles', () => {
  it('returns the tracked files oss/allowlist.txt publishes, minus its excludes', () => {
    const shipped = listShippedFiles(REPO_ROOT)
    expect(shipped).toContain('package.json')
    expect(shipped).toContain('src/server.ts')
    expect(shipped).not.toContain('scripts/backfill-backlog-projects.ts')
  })

  it('throws with the underlying diagnostic when the root is not a publishable tree', () => {
    expect(() => listShippedFiles(os.tmpdir())).toThrow(/oss/)
  })
})

describe.skipIf(!hasPublishTooling)('scanShippedTree', () => {
  it('finds no unexpected outbound URLs in the real published tree', () => {
    expect(scanShippedTree(REPO_ROOT)).toEqual([])
  })

  describe('against a fixture tree', () => {
    let fixtureRoot: string

    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', fixtureRoot, ...args], { stdio: 'pipe' })
    }

    beforeEach(() => {
      fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-guard-'))
      fs.mkdirSync(path.join(fixtureRoot, 'oss'))
      fs.mkdirSync(path.join(fixtureRoot, 'src'))
      // The fixture reuses the real publish reader rather than a copy of it.
      fs.copyFileSync(path.join(REPO_ROOT, 'oss/lib.sh'), path.join(fixtureRoot, 'oss/lib.sh'))
      fs.writeFileSync(path.join(fixtureRoot, 'oss/allowlist.txt'), 'src/\n')
      fs.writeFileSync(path.join(fixtureRoot, URL_ALLOWLIST_RELATIVE_PATH), `${ALLOWLIST_TEXT}\n`)
      fs.writeFileSync(path.join(fixtureRoot, 'src/ok.ts'), `// ${stray('github.com', '/ok')}\n`)
      git('init', '-q')
      git('add', '-A')
    })

    afterEach(() => {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    })

    it('passes when every URL is allow-listed', () => {
      expect(scanShippedTree(fixtureRoot)).toEqual([])
    })

    it('fails on a stray URL and names its file and line', () => {
      fs.writeFileSync(path.join(fixtureRoot, 'src/leak.ts'), `const a = 1\nfetch('${stray('example.net')}')\n`)
      git('add', '-A')
      expect(scanShippedTree(fixtureRoot)).toEqual([
        { file: 'src/leak.ts', line: 2, host: 'example.net', url: stray('example.net') },
      ])
    })

    it('ignores a stray URL in a file that is not published', () => {
      fs.writeFileSync(path.join(fixtureRoot, 'private.md'), stray('example.net'))
      git('add', '-A')
      expect(scanShippedTree(fixtureRoot)).toEqual([])
    })
  })
})
