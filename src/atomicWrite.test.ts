import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomicSync } from './atomicWrite.js'

// Bookmarks M0. Extracted from writeReposDir (reposDir.ts), which
// had the only temp-then-rename write in src/ — the bookmarks store is the second
// caller, so the body moves here rather than being copied. Written red
// during planning.

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-atomic-write-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('writeFileAtomicSync', () => {
  it('writes the content and leaves no temp file behind', () => {
    const filePath = path.join(dir, 'note.json')
    writeFileAtomicSync(filePath, '{"a":1}\n')

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"a":1}\n')
    expect(fs.readdirSync(dir)).toEqual(['note.json'])
  })

  it('creates the parent directory when it does not exist yet', () => {
    const filePath = path.join(dir, 'nested', 'deeper', 'note.json')
    writeFileAtomicSync(filePath, 'x')
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('x')
  })

  it('replaces an existing file in one step', () => {
    const filePath = path.join(dir, 'note.json')
    fs.writeFileSync(filePath, 'old')
    writeFileAtomicSync(filePath, 'new')
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new')
  })

  it('applies the requested mode to the file and to a directory it creates', () => {
    const filePath = path.join(dir, 'owner-only', 'note.json')
    writeFileAtomicSync(filePath, 'x', { fileMode: 0o600, dirMode: 0o700 })

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700)
  })

  it('tightens an existing parent directory to the requested dirMode', () => {
    fs.chmodSync(dir, 0o755)
    writeFileAtomicSync(path.join(dir, 'note.json'), 'x', { dirMode: 0o700 })
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('throws, keeps the old content and removes its temp file when the rename fails', () => {
    // A directory where the file should go makes renameSync fail after the
    // temp file was written — the interrupted-write case.
    const filePath = path.join(dir, 'taken')
    fs.mkdirSync(filePath)
    fs.writeFileSync(path.join(filePath, 'keep'), 'kept')

    expect(() => writeFileAtomicSync(filePath, 'new')).toThrow()
    expect(fs.readFileSync(path.join(filePath, 'keep'), 'utf-8')).toBe('kept')
    expect(fs.readdirSync(dir)).toEqual(['taken'])
  })
})
