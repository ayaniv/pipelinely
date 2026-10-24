import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveBookmarksDir } from './bookmarks.js'

// Bookmarks M0 — bookmarks are personal data: quotes and pointers to
// the developer's own conversations. It must never be committed, published
// or sent anywhere. Each barrier gets its own test so that removing one
// fails on its own:
//   1. it lives outside every checkout (the user config dir), so a commit in
//      the canonical repo can't sweep it up;
//   2. the one bookmarks path that does sit inside the repo, the e2e fixture
//      server's scratch dir, is gitignored — here and in the published repo,
//      whose .gitignore is oss/overlay/.gitignore, not this one;
//   3. nothing that looks like a bookmark file is tracked, so the publish step
//      (which only ships tracked, allowlisted files) has nothing to ship;
//   4. the bookmarks code makes no network calls.
// Written red during planning.

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const BOOKMARK_ID_FILE = /(^|\/)\d{8}T\d{6}Z-[0-9a-f]{6}\.json$/

// Must match FIXTURE_BOOKMARKS_DIR in e2e/fixtures/fixtureDirs.ts — this test is
// what proves that path is ignored, so it names it literally.
const FIXTURE_BOOKMARKS_RELATIVE = path.join('e2e', 'fixtures', 'bookmarks')

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const hasGit = fs.existsSync(path.join(REPO_ROOT, '.git'))
const OVERLAY_GITIGNORE = path.join(REPO_ROOT, 'oss', 'overlay', '.gitignore')
const hasPublishOverlay = fs.existsSync(OVERLAY_GITIGNORE)

describe('bookmarks privacy barriers', () => {
  it('stores bookmarks outside this checkout by default', () => {
    const bookmarksDir = resolveBookmarksDir({}, os.homedir())
    expect(isInside(REPO_ROOT, bookmarksDir)).toBe(false)
  })

  it.skipIf(!hasGit)('keeps the e2e fixture bookmarks gitignored', () => {
    const probe = path.join(FIXTURE_BOOKMARKS_RELATIVE, '20261008T201427Z-a1b2c3.json')
    // check-ignore exits 0 when the path is ignored and throws otherwise.
    expect(() => execFileSync('git', ['check-ignore', '-q', probe], { cwd: REPO_ROOT })).not.toThrow()
  })

  // The publish replaces .gitignore with the overlay's, so the check above
  // proves nothing about the published repo, where e2e runs just the same.
  it.skipIf(!hasPublishOverlay)('keeps the e2e fixture bookmarks gitignored in the published repo too', () => {
    const ignored = fs.readFileSync(OVERLAY_GITIGNORE, 'utf-8').split('\n').map((line) => line.trim())
    expect(ignored).toContain(`${FIXTURE_BOOKMARKS_RELATIVE}/`)
  })

  it.skipIf(!hasGit)('tracks no file that looks like a bookmark', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8' }).split('\n')
    expect(tracked.filter((file) => BOOKMARK_ID_FILE.test(file))).toEqual([])
  })

  it('makes no network calls from the bookmarks modules', () => {
    for (const file of ['bookmarks.ts', 'bookmarksCli.ts', 'bookmarksTranscript.ts']) {
      const source = fs.readFileSync(path.join(REPO_ROOT, 'src', file), 'utf-8')
      expect(source, file).not.toMatch(/\bfetch\(|node:https?['"]|from ['"]https?['"]|https?:\/\//)
    }
  })
})
