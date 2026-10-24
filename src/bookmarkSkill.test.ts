import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

// Bookmarks M0 — the /pipelinely-bookmark skill, run inside any Claude tab. The
// risk in a skill is shell injection, not wording: the text being saved is
// free text (code, quotes, `$(…)`), so it must reach the CLI as stdin through
// a quoted heredoc, never interpolated into a command line. These tests pin
// that as structure, the way feedbackSkill.test.ts pins its privacy guards,
// so the copy can be reworded freely. Written red during planning.

const ROOT = path.join(import.meta.dirname, '..')
// The skill already has its published name, so the publish ships it as it is
// (src/ossBookmarkSkillShip.test.ts). The publish still rewrites Dev/pipelinely
// to Dev/pipelinely, and the published copy runs this file too, so the repo dir
// isn't hard-coded.
const SKILL_NAME = 'pipelinely-bookmark'
const SKILL_PATH = path.join(ROOT, '.claude', 'skills', SKILL_NAME, 'SKILL.md')
const CLI_CALL = /npm --prefix "?\$HOME\/Dev\/(?:cockpit-ai|pipelinely)"? run --silent bookmarks -- (add-text|add-last|add-session|list|rm)\b/g
// The heredoc must be the add-text command's own stdin, on the same line.
const ADD_TEXT_FROM_HEREDOC = /bookmarks -- add-text[^\n]*<<'BOOKMARK_EOF'\n[\s\S]*?\nBOOKMARK_EOF\n/

let skill: string
let bashBlocks: string[]

beforeAll(async () => {
  skill = await fs.readFile(SKILL_PATH, 'utf-8')
  bashBlocks = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1])
})

describe('pipelinely-bookmark skill', () => {
  it('declares its own name and only the Bash tool', () => {
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
    expect(frontmatter).toMatch(new RegExp(`^name: ${SKILL_NAME}$`, 'm'))
    expect(frontmatter).toMatch(/^description: .+/m)
    expect(frontmatter).toMatch(/^allowed-tools: \["Bash"\]$/m)
  })

  it('offers all three ways in: the last answer, a pasted quote, this session', () => {
    const commands = new Set(bashBlocks.flatMap((block) => [...block.matchAll(CLI_CALL)].map((match) => match[1])))
    expect([...commands]).toEqual(expect.arrayContaining(['add-last', 'add-text', 'add-session']))
  })

  it('passes pasted text to add-text only through a quoted heredoc on stdin', () => {
    const addTextBlocks = bashBlocks.filter((block) => block.includes('bookmarks -- add-text'))
    expect(addTextBlocks.length).toBeGreaterThan(0)
    for (const block of addTextBlocks) expect(block).toMatch(ADD_TEXT_FROM_HEREDOC)
  })

  // A title or note the model writes is free text too: `--title "$(…)"` would
  // run. Each one is assigned from a quoted heredoc (no expansion inside) and
  // passed as a double-quoted variable (no re-expansion), the same idea as
  // feedback's heredoc-to-file title.
  it('passes title, note and tags only as variables assigned from quoted heredocs', () => {
    const FLAG_VALUE = /--(title|note|tags) (\S+)/g
    const ALLOWED = { title: '"$BOOKMARK_TITLE"', note: '"$BOOKMARK_NOTE"', tags: '"$BOOKMARK_TAGS"' } as const
    let flagsSeen = 0
    for (const block of bashBlocks) {
      for (const [, flag, value] of block.matchAll(FLAG_VALUE)) {
        flagsSeen += 1
        expect(value, `--${flag} in:\n${block}`).toBe(ALLOWED[flag as keyof typeof ALLOWED])
        const variable = ALLOWED[flag as keyof typeof ALLOWED].slice(2, -1)
        expect(block, `${variable} must come from a quoted heredoc via read`).toContain(`IFS= read -r -d '' ${variable} <<'BOOKMARK_EOF'`)
      }
    }
    expect(flagsSeen).toBeGreaterThan(0)
  })

  // A fixed delimiter ends the heredoc early if the text has a line that is
  // exactly BOOKMARK_EOF, and everything after it then runs as shell.
  it('tells the model to swap the delimiter when the text contains it on a line of its own', () => {
    // Whitespace-normalised so re-wrapping the prose can't break the pin.
    const prose = skill.replace(/\s+/g, ' ')
    expect(prose).toMatch(/line (that is )?exactly `?BOOKMARK_EOF`?/i)
    expect(prose).toMatch(/BOOKMARK_EOF_[A-Za-z0-9<]/)
    expect(prose).toMatch(/both the opening and the closing/i)
  })

  // macOS /bin/bash 3.2 looks for the closing paren of $(…) before it reads
  // the heredoc inside, so a ")" in a title or note ends the substitution and
  // the rest runs as shell. `read` from a heredoc has no such parse.
  it('never wraps a heredoc in $(…) command substitution', () => {
    for (const block of bashBlocks) expect(block).not.toMatch(/\$\(\s*cat\s*<</)
  })

  it('never splices $ARGUMENTS into a shell command', () => {
    for (const block of bashBlocks) expect(block).not.toContain('$ARGUMENTS')
  })

  it('reads the session id from the environment, never from the model', () => {
    const sessionBlocks = bashBlocks.filter((block) => /bookmarks -- add-(last|session)\b/.test(block))
    expect(sessionBlocks.length).toBeGreaterThan(0)
    for (const block of sessionBlocks) expect(block).not.toMatch(/--session\b/)
  })

  it('sends nothing anywhere: no network tools in the skill', () => {
    expect(skill).not.toMatch(/\b(curl|wget|gh)\s/)
    expect(skill).not.toMatch(/https?:\/\//)
  })
})
