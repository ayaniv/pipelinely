import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { feedbackSkillPath, shippedReadmePath } from './publishedTree.js'

// The feedback skill files a PUBLIC GitHub issue from free text Claude writes
// out of the live conversation. These tests pin the privacy guards as
// structure (numbered step headings, named markers) rather than prose, so
// rewording the copy doesn't break them but removing or reordering a guard does.

const ROOT = path.join(__dirname, '..')
const SKILL_PATH = feedbackSkillPath(ROOT)
const GUIDE_PATH = path.join(ROOT, 'docs', 'user-guide.md')
const SHIPPED_README_PATH = shippedReadmePath(ROOT)
const HELP_PAGE_PATH = path.join(ROOT, 'web', 'src', 'views', 'pages', 'HelpPage.tsx')

const STEP_HEADING_RE = /^### (\d+)\. (.+)$/gm

function findStep(skill: string, titlePattern: RegExp): { number: number; body: string } | null {
  const headings = [...skill.matchAll(STEP_HEADING_RE)]
  const index = headings.findIndex((match) => titlePattern.test(match[2]))
  if (index === -1) return null
  const start = headings[index].index! + headings[index][0].length
  const end = headings[index + 1]?.index ?? skill.length
  return { number: Number(headings[index][1]), body: skill.slice(start, end) }
}

const STOP_MARKER = '**STOP AND WAIT.**'
const PRE_CONSENT_SENTENCE = 'Consent given\nbefore the preview does not count'
const FOOTER = 'Filed via /pipelinely-feedback'
const FEEDBACK_TITLE_PATH = '"$FEEDBACK_DIR/title.txt"'
const FEEDBACK_BODY_PATH = '"$FEEDBACK_DIR/body.md"'

function extractBashBlocks(body: string): string[] {
  return [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1])
}

// Every place the skill assigns FEEDBACK_DIR (or FEEDBACK_SESSION_ID) must
// use this exact formula — step 5 runs in a separate, later turn with no
// shell state from step 3, so it has to land on the same path
// independently. Its only input, $TMUX_PANE/$ITERM_SESSION_ID, is the
// terminal session's own environment, stable for the session's whole life
// and already set before the skill runs, not something a step assigns —
// unlike `mktemp` or `$PWD` (model-controlled, can drift between turns),
// which only the step that ran it would ever know or agree on.
function feedbackDirAssignments(skill: string): string[] {
  return [...skill.matchAll(/^FEEDBACK_DIR=.*$/gm)].map((match) => match[0])
}

function feedbackSessionIdAssignments(skill: string): string[] {
  return [...skill.matchAll(/^FEEDBACK_SESSION_ID=.*$/gm)].map((match) => match[0])
}

function feedbackRefusalGuards(skill: string): string[] {
  return [...skill.matchAll(/if \[ -z "\$FEEDBACK_SESSION_ID" \]; then[\s\S]*?\nfi/g)].map((match) => match[0])
}

// Anything that creates a GitHub issue, in any of gh's forms — the ordering
// and inline-body guards below must catch all of these, not just the one
// exact command the skill happens to use today. This loose form also
// matches a mere mention (e.g. "the issue URL `gh issue create` returns" in
// step 6), which is fine for checking nothing runs before the confirm step,
// but too loose for checking nothing runs outside the file step — that one
// needs the stricter, invocation-only form below.
const GH_ISSUE_CREATE_RE = /gh issue create|gh api\s+.*issues/
const GH_ISSUE_INVOCATION_RE = /gh issue create --repo|gh api\s+\S*\/issues\b/
// Any way to pass the body other than --body-file: long form, short form,
// or the = form, all of which put shell-expanded text on the command line.
const INLINE_BODY_FLAG_RE = /(^|\s)(--body\b(?!-file)(=|\s)|-b\s)/

describe('feedback skill', () => {
  let skill: string

  beforeEach(async () => {
    skill = await fs.readFile(SKILL_PATH, 'utf-8')
  })

  it('has a preview step that reads the title and body back from disk', () => {
    const preview = findStep(skill, /^Preview/)
    expect(preview).not.toBeNull()
    expect(preview!.body).toMatch(/title/i)
    expect(preview!.body).toMatch(/body/i)
    expect(preview!.body).toContain('reading those exact files back')
  })

  it('previews the Context block and the footer, so the confirmed text is the posted text', () => {
    const preview = findStep(skill, /^Preview/)
    expect(preview!.body).toContain('Context: ')
    expect(preview!.body).toContain(FOOTER)
  })

  it('states the issue is posted publicly on the pipelinely repo', () => {
    const preview = findStep(skill, /^Preview/)
    expect(preview!.body).toContain('github.com/ayaniv/pipelinely')
    expect(preview!.body).toMatch(/publicly/i)
  })

  it('has a confirm step with the STOP AND WAIT marker and no same-turn posting', () => {
    const confirm = findStep(skill, /^Confirm/)
    expect(confirm).not.toBeNull()
    expect(confirm!.body).toContain(STOP_MARKER)
    expect(confirm!.body).toContain('Do not post in the same turn as the preview')
    expect(confirm!.body).not.toMatch(GH_ISSUE_CREATE_RE)
  })

  it('says consent given before the preview does not count', () => {
    const confirm = findStep(skill, /^Confirm/)
    expect(confirm!.body).toContain(PRE_CONSENT_SENTENCE)
  })

  it('routes an edit back to the preview and a cancel to "nothing was posted"', () => {
    const confirm = findStep(skill, /^Confirm/)
    expect(confirm!.body).toContain('**Edit request:**')
    expect(confirm!.body).toContain('redo step 3 in full')
    expect(confirm!.body).toContain('**Cancel, or no explicit yes:**')
    expect(confirm!.body).toContain('nothing was posted')
  })

  it('creates no GitHub issue — bare gh issue create, gh api, or otherwise — anywhere before the confirm step', () => {
    const confirmHeadingIndex = skill.search(/^### \d+\. Confirm/m)
    expect(confirmHeadingIndex).toBeGreaterThan(-1)
    expect(skill.slice(0, confirmHeadingIndex)).not.toMatch(GH_ISSUE_CREATE_RE)
  })

  it('files in a step numbered after the confirm step, and posts no GitHub issue anywhere else', () => {
    const confirm = findStep(skill, /^Confirm/)
    const file = findStep(skill, /^File the issue/)
    expect(file).not.toBeNull()
    expect(file!.number).toBeGreaterThan(confirm!.number)
    expect(file!.body).toContain('gh issue create --repo ayaniv/pipelinely')
    expect(file!.body).toMatch(GH_ISSUE_INVOCATION_RE)
    const skillWithoutFileStep = skill.slice(0, skill.indexOf(file!.body)) + skill.slice(skill.indexOf(file!.body) + file!.body.length)
    expect(skillWithoutFileStep).not.toMatch(GH_ISSUE_INVOCATION_RE)
  })

  it('posts the previewed files via --body-file, never any inline-body flag form', () => {
    const preview = findStep(skill, /^Preview/)
    const file = findStep(skill, /^File the issue/)
    expect(preview!.body).toContain(FEEDBACK_BODY_PATH)
    expect(preview!.body).toContain(FEEDBACK_TITLE_PATH)
    expect(preview!.body).toContain("<<'FEEDBACK_EOF'")
    expect(file!.body).toContain(`--body-file ${FEEDBACK_BODY_PATH}`)
    expect(file!.body).toContain(FEEDBACK_TITLE_PATH)
    expect(file!.body).not.toMatch(INLINE_BODY_FLAG_RE)
  })

  it('computes FEEDBACK_DIR with the identical formula everywhere it is assigned, and no mktemp, $PWD or other cwd-dependent input', () => {
    const assignments = feedbackDirAssignments(skill)
    // Step 3 (setup) and step 5 each assign it once from scratch.
    expect(assignments.length).toBeGreaterThanOrEqual(2)
    expect(new Set(assignments).size).toBe(1)
    const formula = assignments[0]
    expect(formula).toContain('$HOME')
    expect(formula).toContain('$FEEDBACK_SESSION_ID')
    expect(skill).not.toMatch(/[$(]\s*mktemp/) // no invocation, only the prohibition sentence's mention
    expect(formula).not.toContain('PWD')
    expect(formula).not.toContain('git rev-parse')
    expect(formula).not.toContain('no-session') // silent same-path fallback is gone — see the refusal-guard test
  })

  it('derives FEEDBACK_SESSION_ID from the same formula everywhere, and refuses (never falls back) when neither env var is set', () => {
    const sessionAssignments = feedbackSessionIdAssignments(skill)
    expect(sessionAssignments.length).toBeGreaterThanOrEqual(2)
    expect(new Set(sessionAssignments).size).toBe(1)
    expect(sessionAssignments[0]).toBe('FEEDBACK_SESSION_ID="${TMUX_PANE:-$ITERM_SESSION_ID}"')

    const guards = feedbackRefusalGuards(skill)
    expect(guards.length).toBeGreaterThanOrEqual(2)
    for (const guard of guards) {
      expect(guard).toContain('exit 1')
      expect(guard).toMatch(/refus/i)
    }
  })

  it('keeps the scratch directory out of world-writable /tmp and under a restrictive mode', () => {
    const preview = findStep(skill, /^Preview/)
    expect(preview!.body).toContain('mkdir -p -m 700 "$FEEDBACK_DIR"')
    expect(preview!.body).toContain('chmod 700 "$FEEDBACK_DIR"')
    for (const formula of feedbackDirAssignments(skill)) expect(formula).not.toContain('/tmp')
  })

  it('checks for a symlink at the scratch path and refuses it, before mkdir or chmod could follow it', () => {
    const preview = findStep(skill, /^Preview/)
    const [setupBlock] = extractBashBlocks(preview!.body)
    const symlinkCheckIndex = setupBlock.indexOf('if [ -L "$FEEDBACK_DIR" ]; then')
    const mkdirIndex = setupBlock.indexOf('mkdir -p -m 700')
    expect(symlinkCheckIndex).toBeGreaterThan(-1)
    expect(mkdirIndex).toBeGreaterThan(symlinkCheckIndex)
    expect(setupBlock.slice(symlinkCheckIndex)).toContain('exit 1')
  })

  it('reconstructs the posting path in step 5 from the same formula as step 3, never a shell variable set in an earlier turn', () => {
    const preview = findStep(skill, /^Preview/)
    const file = findStep(skill, /^File the issue/)
    expect(preview!.body).toContain(FEEDBACK_TITLE_PATH)
    expect(file!.body).toContain(FEEDBACK_TITLE_PATH)
    expect(preview!.body).toContain(FEEDBACK_BODY_PATH)
    expect(file!.body).toContain(FEEDBACK_BODY_PATH)
  })

  it('previews by reading back the exact files it wrote, not by reprinting composed text', () => {
    const preview = findStep(skill, /^Preview/)
    expect(preview!.body).toContain(`cat ${FEEDBACK_TITLE_PATH}`)
    expect(preview!.body).toContain(`cat ${FEEDBACK_BODY_PATH}`)
  })

  it('derives distinct, deterministic scratch directories per session, independent of working directory (executes the real setup block)', () => {
    const [setupBlock] = extractBashBlocks(findStep(skill, /^Preview/)!.body)
    const scratchHome = fsSync.mkdtempSync(path.join(os.tmpdir(), 'feedback-skill-test-home-'))
    const compute = (cwd: string, tmuxPane: string) =>
      execFileSync('bash', ['-c', `${setupBlock}\nprintf '%s' "$FEEDBACK_DIR"`], {
        cwd,
        env: { ...process.env, HOME: scratchHome, TMUX_PANE: tmuxPane, ITERM_SESSION_ID: '' },
      }).toString()

    try {
      const paneATwice = [compute(ROOT, 'pane-a'), compute(ROOT, 'pane-a')]
      const paneB = compute(ROOT, 'pane-b')
      const paneAFromDifferentCwd = compute(__dirname, 'pane-a')

      // Deterministic: identical session id lands on the same path every
      // time, so step 5 can reconstruct it independently in a later turn.
      expect(paneATwice[0]).toBe(paneATwice[1])
      // Unique per concurrent session: a different terminal session never
      // collides, so two tabs' /pipelinely-feedback runs can't overwrite each other.
      expect(paneATwice[0]).not.toBe(paneB)
      // Independent of cwd: the very drift that broke the round-3 formula
      // (a cd between step 3 and step 5, or the harness resetting cwd
      // between turns) no longer changes the path at all.
      expect(paneATwice[0]).toBe(paneAFromDifferentCwd)
    } finally {
      fsSync.rmSync(scratchHome, { recursive: true, force: true })
    }
  })

  it('refuses — computes no path and creates nothing — when neither TMUX_PANE nor ITERM_SESSION_ID is set', () => {
    const [setupBlock] = extractBashBlocks(findStep(skill, /^Preview/)!.body)
    const scratchHome = fsSync.mkdtempSync(path.join(os.tmpdir(), 'feedback-skill-test-home-'))
    const env = { ...process.env, HOME: scratchHome, TMUX_PANE: '', ITERM_SESSION_ID: '' }

    try {
      expect(() => execFileSync('bash', ['-c', setupBlock], { cwd: ROOT, env, stdio: 'pipe' })).toThrow()
      // No shared/predictable fallback directory was silently created.
      expect(fsSync.readdirSync(scratchHome)).toEqual([])
    } finally {
      fsSync.rmSync(scratchHome, { recursive: true, force: true })
    }
  })

  it('refuses a pre-planted symlink at the scratch path rather than following it (executes the actual guard)', () => {
    const [setupBlock] = extractBashBlocks(findStep(skill, /^Preview/)!.body)
    const dirAssignmentEnd = setupBlock.indexOf('\nif [ -L "$FEEDBACK_DIR" ]')
    expect(dirAssignmentEnd).toBeGreaterThan(-1)
    const computeDirOnly = setupBlock.slice(0, dirAssignmentEnd)

    const scratchHome = fsSync.mkdtempSync(path.join(os.tmpdir(), 'feedback-skill-test-home-'))
    const env = { ...process.env, HOME: scratchHome, TMUX_PANE: 'pane-symlink', ITERM_SESSION_ID: '' }
    const victim = fsSync.mkdtempSync(path.join(os.tmpdir(), 'feedback-skill-test-victim-'))

    try {
      fsSync.chmodSync(victim, 0o755)
      const scratchDir = execFileSync('bash', ['-c', `${computeDirOnly}\nprintf '%s' "$FEEDBACK_DIR"`], { cwd: ROOT, env }).toString()
      fsSync.mkdirSync(path.dirname(scratchDir), { recursive: true })
      fsSync.symlinkSync(victim, scratchDir)

      expect(() => execFileSync('bash', ['-c', setupBlock], { cwd: ROOT, env, stdio: 'pipe' })).toThrow()
      // The guard refused before mkdir/chmod ever ran, so the symlink's
      // target keeps its original mode — never followed and chmod'd to 700.
      expect(fsSync.statSync(victim).mode & 0o777).toBe(0o755)
    } finally {
      fsSync.rmSync(scratchHome, { recursive: true, force: true })
      fsSync.rmSync(victim, { recursive: true, force: true })
    }
  })

  it("posts exactly what step 3 wrote to disk, read back by step 5 — not a re-composed copy (executes both steps' actual commands, gh shadowed so nothing is really invoked)", () => {
    const preview = findStep(skill, /^Preview/)
    const file = findStep(skill, /^File the issue/)
    const [setupBlock, writeBlock] = extractBashBlocks(preview!.body)
    const [postBlock] = extractBashBlocks(file!.body)
    expect(setupBlock).toBeTruthy()
    expect(writeBlock).toBeTruthy()
    expect(postBlock).toBeTruthy()

    const sampleTitle = 'Backtick `rm -rf /` and $(danger) and "quotes" in the title'
    const sampleBody = 'Body with $VAR, `code`, "quotes" and !history\n\n---\nContext: none\nFiled via /pipelinely-feedback'
    const filledWriteBlock = writeBlock
      .replace('<title>', sampleTitle)
      .replace('<body, ending with the Context block and footer>', sampleBody)

    const scratchHome = fsSync.mkdtempSync(path.join(os.tmpdir(), 'feedback-skill-test-'))
    const env = { ...process.env, HOME: scratchHome, TMUX_PANE: 'test-pane', ITERM_SESSION_ID: '' }
    const cwd = ROOT

    try {
      execFileSync('bash', ['-c', `${setupBlock}\n${filledWriteBlock}`], { cwd, env })

      const outFile = path.join(scratchHome, 'gh-args.txt')
      const ghShim = `gh() { printf '%s\\n' "$@" > ${JSON.stringify(outFile)}; }\n`
      execFileSync('bash', ['-c', ghShim + postBlock], { cwd, env })

      const recordedArgs = fsSync.readFileSync(outFile, 'utf-8').split('\n')
      expect(recordedArgs).toContain(sampleTitle)
      const bodyFileIndex = recordedArgs.indexOf('--body-file')
      expect(bodyFileIndex).toBeGreaterThan(-1)
      const postedBodyPath = recordedArgs[bodyFileIndex + 1]
      expect(fsSync.readFileSync(postedBodyPath, 'utf-8')).toBe(sampleBody + '\n')
    } finally {
      fsSync.rmSync(scratchHome, { recursive: true, force: true })
    }
  })

  it('requires an edit to redo the quoted-heredoc write, not patch the files in place', () => {
    const confirm = findStep(skill, /^Confirm/)
    expect(confirm!.body).toContain('redo step 3 in full')
    expect(confirm!.body).toMatch(/the same\s+quoted-heredoc write/)
    expect(confirm!.body).toMatch(/Never\s+patch the files with `echo`/)
  })

  it('cleans up the scratch directory on cancel, and only after a confirmed successful post', () => {
    const confirm = findStep(skill, /^Confirm/)
    const file = findStep(skill, /^File the issue/)
    const report = findStep(skill, /^Report/)
    expect(confirm!.body).toContain('rm -rf "$FEEDBACK_DIR"')
    expect(report!.body).toContain('rm -rf "$FEEDBACK_DIR"')
    expect(report!.body).toContain('Only now, after a confirmed successful post')
    // A failed or abandoned post must NOT delete the scratch files — step 5
    // promises a retry with the same files, so cleanup there would break it.
    expect(file!.body).not.toContain('rm -rf')
    expect(file!.body).toContain('do not delete')
  })

  it('adds nothing after the preview, so the footer is not appended post-confirmation', () => {
    const file = findStep(skill, /^File the issue/)
    expect(file!.body).toContain('Add nothing and change nothing after the preview')
    expect(file!.body).not.toContain(FOOTER)
  })

  it('lists every excluded detail class in the context step', () => {
    const context = findStep(skill, /context/i)
    expect(context).not.toBeNull()
    const excluded = [
      'filesystem paths', 'usernames and home-directory names', 'repository names',
      'task slugs or titles', 'branch names', 'PR numbers of the user', "code from the user's project",
      'emails, tokens and secrets', 'hostnames and IP addresses', 'environment variable values',
      '`gh` auth details',
    ]
    for (const item of excluded) expect(context!.body, item).toContain(item)
    expect(context!.body).toContain('unless the user asked')
  })

  it('scrubs error and command text instead of pasting it raw', () => {
    const context = findStep(skill, /context/i)
    expect(context!.body).toContain('never paste it raw')
    expect(context!.body).not.toMatch(/any error message seen|relevant command or\s+task/i)
  })

  it("scopes the public-names exemption to Pipelinely's own names", () => {
    const context = findStep(skill, /context/i)
    expect(context!.body).toContain("Pipelinely's own file and function names")
    expect(context!.body).not.toContain('this project')
  })

  it('makes the preview flag details the report needs or the user text contained', () => {
    const preview = findStep(skill, /^Preview/)
    expect(preview!.body).toContain('Name any details from step 2')
    expect(preview!.body).toContain("or\nthat the user's own text contained")
  })

  it('reports failure as nothing posted, leaves the scratch files for a retry, and requires a fresh yes', () => {
    const file = findStep(skill, /^File the issue/)
    expect(file!.body).toContain('gh auth login')
    expect(file!.body).toContain('nothing was posted')
    expect(file!.body).toContain('a retry can reuse them')
    expect(file!.body).toContain('fresh yes')
  })

  it('says public in the frontmatter description', () => {
    const description = skill.match(/^description: (.+)$/m)![1]
    expect(description).toContain('public GitHub issue')
  })

  it('stays portable across the cockpit and pipelinely names', () => {
    expect(skill).not.toMatch(/cockpit/i)
  })
})

describe('feedback copy outside the skill', () => {
  it('user guide says the Help page files a public GitHub issue', async () => {
    const guide = await fs.readFile(GUIDE_PATH, 'utf-8')
    expect(guide).toMatch(/public GitHub\s+issue/i)
    expect(guide).not.toMatch(/for sending feedback/i)
  })

  it('user guide is honest that the issue is visible to everyone and the confirmation is prompt-level', async () => {
    const guide = await fs.readFile(GUIDE_PATH, 'utf-8')
    expect(guide).toContain('visible to\neveryone')
    expect(guide).toContain('not a system prompt')
  })

  it('published README describes a public issue after a shown preview and explicit yes', async () => {
    const readme = await fs.readFile(SHIPPED_README_PATH, 'utf-8')
    expect(readme).not.toContain('short summary of what you were doing')
    expect(readme).toContain('public GitHub issue')
    expect(readme).toContain('explicit yes')
  })

  it('React Help page is labelled as a public GitHub issue, not "Send feedback"', async () => {
    const helpPage = await fs.readFile(HELP_PAGE_PATH, 'utf-8')
    expect(helpPage).not.toContain('>Send feedback<')
    expect(helpPage).toContain('File a public GitHub issue')
  })
})
