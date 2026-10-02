import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { shippedReadmePath } from './publishedTree.js'
import { extractPrivacySection, findBannedPrivacyPhrases, missingPrivacyStatements } from './privacyWording.js'

// Scope is deliberately narrow: the three docs and the Help page are the
// copy that makes privacy claims. Skill prompts and internal docs are not
// scanned — they use words like "offline" for technical reasons (e.g. a gh
// note), which would need an allowlist and is not a claim to the user.
const REPO_ROOT = path.join(__dirname, '..')
// In the published tree the shipped README is README.md itself, so it is listed
// once there instead of being compared with itself under a duplicate title.
const SHIPPED_DOCS = [...new Set(['README.md', 'docs/user-guide.md', path.relative(REPO_ROOT, shippedReadmePath(REPO_ROOT))])]
// Copy the user reads inside the dashboard, outside the markdown docs.
const SHIPPED_UI_COPY = ['web/src/views/pages/HelpPage.tsx']

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8')
}

describe('findBannedPrivacyPhrases', () => {
  it.each([
    'Everything is local-only.',
    'Your work is Local Only.',
    'Nothing leaves your machine.',
    'It works offline.',
    'There is no network involved.',
    'A private dashboard.',
  ])('flags %s', (text) => {
    expect(findBannedPrivacyPhrases(text)).toHaveLength(1)
  })

  it('reports the 1-based line of each hit', () => {
    const [hit] = findBannedPrivacyPhrases('fine line\nstill fine\nthis is offline only')
    expect(hit.line).toBe(3)
  })

  it('accepts the qualified claim and the loopback binding wording', () => {
    const text = [
      'No Pipelinely servers receive your code, sessions or pipeline state.',
      'The dashboard listens on 127.0.0.1 only by default.',
      'Claude Code still talks to Anthropic and git/gh talk to GitHub.',
    ].join('\n')
    expect(findBannedPrivacyPhrases(text)).toEqual([])
  })
})

describe('missingPrivacyStatements', () => {
  it('reports nothing for text carrying every required statement', () => {
    const text =
      'No Pipelinely server receives your code. Claude Code still talks to Anthropic; git and gh talk to GitHub. ' +
      'The dashboard listens on 127.0.0.1; set PIPELINELY_HOST to opt in to other devices.'
    expect(missingPrivacyStatements(text)).toEqual([])
  })

  it('tolerates a line re-wrap inside a required phrase', () => {
    const text = 'No Pipelinely\nservers receive code. Anthropic and GitHub are involved. 127.0.0.1 and PIPELINELY_HOST.'
    expect(missingPrivacyStatements(text)).toEqual([])
  })

  it('names each statement that is absent', () => {
    expect(missingPrivacyStatements('A dashboard.')).toEqual([
      'no-pipelinely-servers',
      'anthropic-and-github',
      'loopback-binding',
    ])
  })
})

describe('extractPrivacySection', () => {
  it('returns the text from the Privacy heading up to the next heading', () => {
    const section = extractPrivacySection('# T\n\n## Privacy\n\nBody line.\n\n## Network access\n\nOther.')
    expect(section).toContain('Body line.')
    expect(section).not.toContain('Other.')
  })

  it('returns an empty string when there is no Privacy section, so required statements are reported missing', () => {
    const section = extractPrivacySection('## Network access\n\n127.0.0.1 PIPELINELY_HOST')
    expect(section).toBe('')
    expect(missingPrivacyStatements(section)).toHaveLength(3)
  })
})

describe('shipped copy', () => {
  it.each([...SHIPPED_DOCS, ...SHIPPED_UI_COPY])('%s has no banned privacy phrase', (file) => {
    expect(findBannedPrivacyPhrases(readRepoFile(file))).toEqual([])
  })

  it.each(SHIPPED_DOCS)('%s states who receives what and how the dashboard binds', (file) => {
    expect(missingPrivacyStatements(extractPrivacySection(readRepoFile(file)))).toEqual([])
  })

  it.each(SHIPPED_DOCS)('%s does not claim git/gh traffic is unchanged by Pipelinely', (file) => {
    expect(extractPrivacySection(readRepoFile(file))).not.toMatch(/does not see or change/i)
  })

  // The user guide links its sibling section by name, the READMEs by anchor.
  const normalizeNetworkAccessLink = (section: string) =>
    section.replace('(see [Network access](#network-access))', '(see "Network access" below)')

  it('keeps the Privacy section identical across the shipped docs', () => {
    const [readme, ...others] = SHIPPED_DOCS.map((file) =>
      normalizeNetworkAccessLink(extractPrivacySection(readRepoFile(file)))
    )
    for (const section of others) expect(section).toBe(readme)
  })
})
