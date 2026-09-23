import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  extractSkillReferences,
  listPublishedSkillDirs,
  findWrittenSubsetViolations,
} from './docsGuide.js'

// Guards docs/user-guide.md against rot and against the two renderers'
// combined subset (tech-design-pipelinely-docs.md §1/§5): every published
// skill is named and every named skill exists, and the guide's Markdown
// source stays inside the block-syntax/link/heading rules the dashboard's
// renderMarkdownToHtml and pipelinely-marketing's plain react-markdown (no
// remark-gfm) both need — plus the private-repo-name ban, which applies to
// cockpit-ai's own copy too since the guide is public prose either way.

const REAL_SKILLS_DIR = path.join(__dirname, '..', '.claude', 'skills')
const REAL_ALLOWLIST_PATH = path.join(__dirname, '..', 'oss', 'allowlist.txt')
const REAL_GUIDE_PATH = path.join(__dirname, '..', 'docs', 'user-guide.md')

describe('extractSkillReferences', () => {
  it('extracts the leading /<name> token of an inline-code span', () => {
    expect(extractSkillReferences('Run `/pipelinely-dev <slug>` to start.')).toEqual(['pipelinely-dev'])
  })

  it('extracts a bare skill reference with no arguments', () => {
    expect(extractSkillReferences('Then `/pipelinely` takes over.')).toEqual(['pipelinely'])
  })

  it('does not treat a bare path in prose (not inline code) as a skill reference', () => {
    expect(extractSkillReferences('Opens the guide at https://pipelinely.cc/docs.')).toEqual([])
  })

  it('deduplicates repeated references', () => {
    expect(extractSkillReferences('`/pipelinely-dev x` ... later, `/pipelinely-dev y` again.')).toEqual(['pipelinely-dev'])
  })
})

describe('listPublishedSkillDirs', () => {
  let tmpDir: string

  it('excludes a directory named by a !.claude/skills/<name>/ allowlist line', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-docsguide-'))
    await fs.mkdir(path.join(tmpDir, 'skills', 'kept'), { recursive: true })
    await fs.mkdir(path.join(tmpDir, 'skills', 'excluded'), { recursive: true })
    const allowlistPath = path.join(tmpDir, 'allowlist.txt')
    await fs.writeFile(allowlistPath, '.claude/skills/\n!.claude/skills/excluded/\n')

    const dirs = await listPublishedSkillDirs(path.join(tmpDir, 'skills'), allowlistPath)
    expect(dirs.sort()).toEqual(['kept'])
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('falls back to every directory when the allowlist file does not exist (the pipelinely case: oss/ is never published)', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-docsguide-'))
    await fs.mkdir(path.join(tmpDir, 'skills', 'a'), { recursive: true })
    await fs.mkdir(path.join(tmpDir, 'skills', 'b'), { recursive: true })

    const dirs = await listPublishedSkillDirs(path.join(tmpDir, 'skills'), path.join(tmpDir, 'no-such-allowlist.txt'))
    expect(dirs.sort()).toEqual(['a', 'b'])
    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})

describe('findWrittenSubsetViolations', () => {
  it('passes a guide that follows every rule', () => {
    const clean = [
      '# Guide',
      '',
      '## Getting started',
      '',
      'Run `/pipelinely` in a repo. See [the repo](https://github.com/ayaniv/pipelinely).',
      '',
      '- one flat item',
      '- another flat item',
      '',
      '```',
      'npm install',
      '```',
    ].join('\n')
    expect(findWrittenSubsetViolations(clean)).toEqual([])
  })

  it('catches a table row', () => {
    const violations = findWrittenSubsetViolations('## Section\n\n| a | b |\n| - | - |\n')
    expect(violations.some((v) => v.rule === 'no-tables')).toBe(true)
  })

  it('catches a nested list item', () => {
    const violations = findWrittenSubsetViolations('## Section\n\n- top\n  - nested\n')
    expect(violations.some((v) => v.rule === 'no-nested-lists')).toBe(true)
  })

  it('catches a blockquote', () => {
    const violations = findWrittenSubsetViolations('## Section\n\n> quoted text\n')
    expect(violations.some((v) => v.rule === 'no-blockquotes')).toBe(true)
  })

  it('catches an image', () => {
    const violations = findWrittenSubsetViolations('## Section\n\n![alt text](https://example.com/x.png)\n')
    expect(violations.some((v) => v.rule === 'no-images')).toBe(true)
  })

  it('catches a non-https link', () => {
    const violations = findWrittenSubsetViolations('## Section\n\nSee [notes](./CONTRIBUTING.md).\n')
    expect(violations.some((v) => v.rule === 'links-must-be-absolute-https')).toBe(true)
  })

  it('catches a link path containing /pipelinely-feedback', () => {
    const violations = findWrittenSubsetViolations('## Section\n\nSee [it](https://github.com/ayaniv/pipelinely/pipelinely-feedback).\n')
    expect(violations.some((v) => v.rule === 'no-feedback-or-handover-link-path')).toBe(true)
  })

  it('catches a link path containing /pipelinely-handover', () => {
    const violations = findWrittenSubsetViolations('## Section\n\nSee [it](https://github.com/ayaniv/pipelinely/pipelinely-handover).\n')
    expect(violations.some((v) => v.rule === 'no-feedback-or-handover-link-path')).toBe(true)
  })

  it('catches formatting inside a ## heading', () => {
    const violations = findWrittenSubsetViolations('## The `pipeline` stages\n\nBody.\n')
    expect(violations.some((v) => v.rule === 'plain-heading-text')).toBe(true)
  })

  it('catches the private repo name', () => {
    const violations = findWrittenSubsetViolations('## Section\n\nClone cockpit-ai locally.\n')
    expect(violations.some((v) => v.rule === 'no-private-repo-name')).toBe(true)
  })

  it('ignores structural patterns inside a fenced code block', () => {
    const guide = '## Section\n\n```\n| not | a | table |\n- not a real bullet, just an example\n```\n'
    expect(findWrittenSubsetViolations(guide)).toEqual([])
  })
})

describe('the real docs/user-guide.md', () => {
  it('names every published skill and names no skill that does not exist as a directory', async () => {
    const guideMd = await fs.readFile(REAL_GUIDE_PATH, 'utf-8')
    const published = await listPublishedSkillDirs(REAL_SKILLS_DIR, REAL_ALLOWLIST_PATH)
    const referenced = extractSkillReferences(guideMd)
    const allSkillDirs = await fs.readdir(REAL_SKILLS_DIR)

    for (const skill of published) {
      expect(referenced, `guide should reference published skill /${skill}`).toContain(skill)
    }
    for (const skill of referenced) {
      expect(allSkillDirs, `guide references /${skill}, which has no .claude/skills/ directory`).toContain(skill)
    }
  })

  it('has no written-subset violations', async () => {
    const guideMd = await fs.readFile(REAL_GUIDE_PATH, 'utf-8')
    expect(findWrittenSubsetViolations(guideMd)).toEqual([])
  })

  it('has more than a couple of ## sections', async () => {
    const guideMd = await fs.readFile(REAL_GUIDE_PATH, 'utf-8')
    const sectionCount = (guideMd.match(/^## /gm) ?? []).length
    expect(sectionCount).toBeGreaterThan(2)
  })
})
