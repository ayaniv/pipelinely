import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPublishedTree, feedbackSkillPath, shippedReadmePath } from './publishedTree.js'

const PUBLISH_SCRIPT = path.join('oss', 'publish.sh')

describe('publishedTree', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'published-tree-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function makeMasterLayout(): void {
    fs.mkdirSync(path.join(root, 'oss'), { recursive: true })
    fs.writeFileSync(path.join(root, PUBLISH_SCRIPT), '')
  }

  it('master layout (oss/publish.sh present): not published, original skill and overlay README paths', () => {
    makeMasterLayout()
    expect(isPublishedTree(root)).toBe(false)
    expect(feedbackSkillPath(root)).toBe(path.join(root, '.claude', 'skills', 'feedback', 'SKILL.md'))
    expect(shippedReadmePath(root)).toBe(path.join(root, 'oss', 'overlay', 'README.md'))
  })

  it('published layout (no oss/): published, renamed skill and root README paths', () => {
    expect(isPublishedTree(root)).toBe(true)
    expect(feedbackSkillPath(root)).toBe(path.join(root, '.claude', 'skills', 'pipelinely-feedback', 'SKILL.md'))
    expect(shippedReadmePath(root)).toBe(path.join(root, 'README.md'))
  })

  it('failure path: on master a deleted skill or overlay README stays a missing file, never a silent fallback', () => {
    makeMasterLayout()
    fs.mkdirSync(path.join(root, '.claude', 'skills', 'pipelinely-feedback'), { recursive: true })
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'pipelinely-feedback', 'SKILL.md'), 'x')
    fs.writeFileSync(path.join(root, 'README.md'), 'x')
    expect(fs.existsSync(feedbackSkillPath(root))).toBe(false)
    expect(fs.existsSync(shippedReadmePath(root))).toBe(false)
  })
})
