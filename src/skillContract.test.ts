import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { isPublishedTree } from './publishedTree.js'
import { loadStageScopes, parseStageScope } from './stageScope.js'

// Contract over the real skill files and orchestrator-prompt.md: the intent
// guarantees are instructions to an LLM, so the only mechanical check that
// they still say what they must is reading the files themselves. Pinned as
// structure (sections, markers, commands), not prose, so rewording the copy
// doesn't break these but dropping a guarantee does.

const ROOT = path.join(import.meta.dirname, '..')
const SKILLS_DIR = path.join(ROOT, '.claude', 'skills')
const ORCHESTRATOR_PROMPT = path.join(ROOT, 'orchestrator-prompt.md')
const CONSTRAINTS_PATH = path.join(ROOT, 'docs', 'engineering-constraints.md')
const WRITE_INTENT = 'scripts/write-intent.sh'
const TOOL_PREFIX = 'npm --prefix $HOME/Dev/pipelinely run --silent'

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

function skill(name: string): string {
  return read(path.join(SKILLS_DIR, name, 'SKILL.md'))
}

function allInstructionFiles(): { name: string; content: string }[] {
  const skills = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, entry.name, 'SKILL.md')))
    .map((entry) => ({ name: `${entry.name}/SKILL.md`, content: skill(entry.name) }))
  return [...skills, { name: 'orchestrator-prompt.md', content: read(ORCHESTRATOR_PROMPT) }]
}

// The text from a column-0 heading line up to the next heading of the same
// or a higher level — the "## Step 2" body of a skill, for instance.
function headingSection(content: string, headingPrefix: string): string {
  const lines = content.split('\n')
  const start = lines.findIndex((line) => line.startsWith(headingPrefix))
  if (start === -1) return ''
  const level = headingPrefix.match(/^#+/)![0].length
  const end = lines.findIndex((line, i) => i > start && new RegExp(`^#{1,${level}} `).test(line))
  return lines.slice(start, end === -1 ? lines.length : end).join('\n')
}

// orchestrator-prompt.md's numbered top-level steps ("3. **Write TASK.md**").
function orchestratorStep(content: string, stepNumber: number): string {
  const lines = content.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${stepNumber}. **`))
  const end = lines.findIndex((line, i) => i > start && line.startsWith(`${stepNumber + 1}. **`))
  return start === -1 ? '' : lines.slice(start, end === -1 ? lines.length : end).join('\n')
}

// Shell writes, and an imperative "Write `…INTENT.md`", that target INTENT.md.
// The redirect form needs whitespace before the `>` so a `<tasks-dir>/<slug>/
// INTENT.md` placeholder path doesn't read as one.
const INTENT_WRITE_PATTERNS = [
  /(^|\s)>>?\s*["']?[^\s"']*INTENT\.md/,
  /(\btee\b|\bcp\b|\bmv\b|\btouch\b|\bchmod\b|\bsed\s+-i\b)[^\n]*INTENT\.md/,
  /^\s*(\d+\.\s+)?(\*\*)?Write\s+`[^`]*INTENT\.md`/,
]

describe('INTENT.md has a single writer', () => {
  it('no skill or orchestrator instruction writes INTENT.md except through scripts/write-intent.sh', () => {
    const offenders: string[] = []
    for (const { name, content } of allInstructionFiles()) {
      content.split('\n').forEach((line, i) => {
        if (line.includes('write-intent.sh')) return
        if (INTENT_WRITE_PATTERNS.some((pattern) => pattern.test(line))) offenders.push(`${name}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  // The public overlay .gitignore ignores tasks/** and ships no tasks/ scaffold
  // on purpose, so there is no INTENT.md record to version-control there.
  it.skipIf(isPublishedTree(ROOT))('.gitignore allow-lists tasks/*/INTENT.md so the record is version-controlled', () => {
    expect(read(path.join(ROOT, '.gitignore')).split('\n')).toContain('!tasks/*/INTENT.md')
  })

  it.skipIf(!isPublishedTree(ROOT))('published .gitignore ignores tasks/** wholesale, with no allow-list', () => {
    const lines = read(path.join(ROOT, '.gitignore')).split('\n')
    expect(lines).toContain('tasks/**')
    expect(lines.filter((line) => line.startsWith('!tasks/'))).toEqual([])
  })
})

describe('INTENT.md is created before the tab opens', () => {
  it('orchestrator step 3 creates it with write-intent.sh --create, before step 4 opens the tab', () => {
    const prompt = read(ORCHESTRATOR_PROMPT)
    const step3 = orchestratorStep(prompt, 3)

    expect(step3).toContain(WRITE_INTENT)
    expect(step3).toContain('--create')
    // The one place the creators' exit-code handling is defined (exit 3 =
    // already recorded, carry on); the skills point here instead of copying it.
    expect(step3).toMatch(/exit 3/)
    expect(orchestratorStep(prompt, 4)).not.toContain('--create')
  })

  it('a promoted backlog item is captured (line plus context line) before the line is removed from BACKLOG.md', () => {
    const backlog = headingSection(read(ORCHESTRATOR_PROMPT), '## Backlog')
    const promoting = backlog.split('\n').find((line) => line.startsWith('- **Promoting an item:**')) ?? ''

    expect(promoting).toContain(WRITE_INTENT)
    expect(promoting.indexOf(WRITE_INTENT)).toBeLessThan(promoting.indexOf('remove it from `BACKLOG.md`'))
  })

  it('pipelinely-planning Step 2 creates it with write-intent.sh --create', () => {
    const step2 = headingSection(skill('pipelinely-planning'), '## Step 2')

    expect(step2).toContain(WRITE_INTENT)
    expect(step2).toContain('--create')
    expect(step2).toContain('--created-by pipelinely-planning')
  })

  it('pipelinely-dev Step 2 creates it for a new dir, with --source milestone for a <parent>-m<N> child', () => {
    const step2 = headingSection(skill('pipelinely-dev'), '## Step 2')

    expect(step2).toContain(WRITE_INTENT)
    expect(step2).toContain('--create')
    expect(step2).toContain('--created-by pipelinely-dev')
    expect(step2).toContain('--source milestone')
  })
})

describe('pipelinely-cr', () => {
  const cr = () => skill('pipelinely-cr')

  it('renders its brief with the stage-brief CLI through the tool checkout #132 settled on, into TASK-cr.md', () => {
    expect(cr()).toContain(`${TOOL_PREFIX} stage-brief -- code-review <slug> <PR>`)
    expect(cr()).toContain('TASK-cr.md')
    expect(cr()).not.toContain('${REPOS_DIR')
  })

  it('never writes TASK.md: no "Write …/TASK.md" step, no "(overwrite)", no reuse cp of TASK.md', () => {
    expect(cr()).not.toMatch(/Write `[^`]*\/TASK\.md`/)
    expect(cr()).not.toContain('(overwrite)')
    expect(cr()).not.toMatch(/\bcp\b[^\n]*TASK\.md/)
  })

  it('carries exactly one brief-template marker pair, and keeps its example-report pair', () => {
    expect(cr().match(/<!-- brief-template:start -->/g)).toHaveLength(1)
    expect(cr().match(/<!-- brief-template:end -->/g)).toHaveLength(1)
    expect(cr().indexOf('<!-- brief-template:start -->')).toBeLessThan(cr().indexOf('<!-- brief-template:end -->'))
    expect(cr()).toContain('<!-- example-report:start -->')
  })

  it('its "## Steps" still parse for the dashboard\'s stage-scope summary, and include the intent check', () => {
    const steps = parseStageScope(cr(), null).steps

    expect(steps.length).toBeGreaterThan(0)
    // INTENT.md, not just "intent": today's Step 2 already says "for intent"
    // about the PR body, which is exactly what this slice replaces.
    expect(steps.some((step) => step.includes('INTENT.md'))).toBe(true)
  })

  it('loadStageScopes still returns non-empty steps for code-review against the real skills dir', async () => {
    const scopes = await loadStageScopes(SKILLS_DIR, CONSTRAINTS_PATH)

    expect(scopes['code-review']?.steps.length).toBeGreaterThan(0)
  })

  it('its tab reads TASK-cr.md by absolute path instead of copying a TASK.md into the worktree', () => {
    const step3 = headingSection(cr(), '## Step 3')

    expect(step3).toContain('TASK-cr.md')
    expect(step3).not.toMatch(/\bcp\b/)
  })
})

describe('orchestrator-prompt.md Reusable form', () => {
  it('carves pipelinely-cr out of the reuse-worktree TASK.md cp, pointing it at TASK-cr.md instead', () => {
    const prompt = read(ORCHESTRATOR_PROMPT)
    const reuseNote = prompt.split('\n').find((line) => line.includes('**Reuse-worktree `TASK.md` refresh')) ?? ''
    const worktreeRow = prompt.split('\n').find((line) => line.trim().startsWith('| Worktree |')) ?? ''

    expect(reuseNote).toContain('TASK-cr.md')
    expect(worktreeRow).toContain('TASK-cr.md')
  })
})
