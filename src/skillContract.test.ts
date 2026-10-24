import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPublishedTree } from './publishedTree.js'
import { loadStageScopes, parseStageScope } from './stageScope.js'
import { formatBacklogItemLine, parseBacklogContent } from './taskParser.js'

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
const OSS_LIB_PATH = path.join(ROOT, 'oss', 'lib.sh')
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

  it('pipelinely-dev Step 1 runs the dev-guard CLI before the <parent>-m<N> match, and handles all three exit codes', () => {
    const step1 = headingSection(skill('pipelinely-dev'), '## Step 1')
    const guardAt = step1.indexOf(`${TOOL_PREFIX} dev-guard -- <slug>`)

    expect(guardAt).toBeGreaterThanOrEqual(0)
    expect(guardAt).toBeLessThan(step1.indexOf('matches `<parent>-m<N>`'))
    expect(step1).toContain('Exit `0`')
    expect(step1).toContain('Exit `2`')
    expect(step1).toContain('Exit `1`')
    expect(step1).toContain('Do not create a task dir, worktree or tab')
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

describe('pipelinely-merge-conflicts', () => {
  const mc = () => skill('pipelinely-merge-conflicts')

  it('renders its brief with the stage-brief CLI through the tool checkout, into TASK-merge.md', () => {
    expect(mc()).toContain(`${TOOL_PREFIX} stage-brief -- merge-conflicts <slug>`)
    expect(mc()).toContain('TASK-merge.md')
    expect(mc()).not.toContain('${REPOS_DIR')
  })

  it('never writes TASK.md: no "Write …/TASK.md" step, no "(overwrite)", no cp of TASK.md', () => {
    expect(mc()).not.toMatch(/Write `[^`]*\/TASK\.md`/)
    expect(mc()).not.toContain('(overwrite)')
    expect(mc()).not.toMatch(/\bcp\b[^\n]*TASK\.md/)
  })

  it('carries exactly one brief-template marker pair, in order', () => {
    expect(mc().match(/<!-- brief-template:start -->/g)).toHaveLength(1)
    expect(mc().match(/<!-- brief-template:end -->/g)).toHaveLength(1)
    expect(mc().indexOf('<!-- brief-template:start -->')).toBeLessThan(mc().indexOf('<!-- brief-template:end -->'))
  })

  it('its template ends with the Branch line, so nothing after it can parse as a branch', () => {
    const template = mc().split('<!-- brief-template:start -->')[1].split('<!-- brief-template:end -->')[0]
    expect(template.trimEnd().split('\n').at(-1)).toBe('- Branch: {{branch}}')
  })

  it('its "## Steps" parse for the stage-scope summary, and loadStageScopes finds them for merge-conflicts', async () => {
    expect(parseStageScope(mc(), null).steps.length).toBeGreaterThan(0)
    const scopes = await loadStageScopes(SKILLS_DIR, CONSTRAINTS_PATH)
    expect(scopes['merge-conflicts']?.steps.length).toBeGreaterThan(0)
  })

  it('opens an ephemeral worker-<slug>-merge tab that does not claim the pointers, with COCKPIT_STAGE merge-conflicts', () => {
    const step3 = headingSection(mc(), '## Step 3')

    expect(step3).toContain('worker-<slug>-merge')
    expect(step3).toMatch(/Claim `ITERM_SESSION`\/`TMUX_SESSION`: \*\*no\*\*/)
    expect(step3).toContain('TASK-merge.md')
    expect(step3).not.toMatch(/\bcp\b/)
    expect(step3).toMatch(/`COCKPIT_STAGE`: `merge-conflicts`/)
  })

  it('merges, never rebases or force-pushes, and restores the STATUS the task had before', () => {
    expect(mc()).toContain('git merge {{baseRef}}')
    expect(mc()).not.toMatch(/git merge origin\/master/)
    expect(mc()).toMatch(/never (a )?rebase/i)
    expect(mc()).toMatch(/never force-push/i)
    expect(mc()).toContain('{{previousStatus}}')
  })
})

describe('pipelinely-design-qa', () => {
  const designQa = () => skill('pipelinely-design-qa')

  it('writes DESIGN_QA.md and design-qa/ screenshots into the tasks dir, and the design-qa TIMELINE line and approval hand-off STATUS', () => {
    expect(designQa()).toContain('DESIGN_QA.md')
    expect(designQa()).toContain('/design-qa/')
    expect(designQa()).toContain('Story | Theme | Storybook | Figma | Match')
    expect(designQa()).toContain('design-qa <n stories compared, k mismatches flagged>')
    expect(designQa()).toContain('waiting: design QA done, ready for design approval')
  })

  it('compares Light and Dark through Storybook and the Figma MCP, and stops rather than guessing when either is unavailable', () => {
    expect(designQa()).toContain('Light and Dark')
    expect(designQa()).toContain('Figma MCP')
    expect(designQa()).toMatch(/never write a passing report on a guess/i)
  })

  it('opens an ephemeral worker-<slug>-dqa tab that does not claim the pointers, with COCKPIT_STAGE design-qa', () => {
    const step3 = headingSection(designQa(), '## Step 3')

    expect(step3).toContain('worker-<slug>-dqa')
    expect(step3).toMatch(/Claim `ITERM_SESSION`\/`TMUX_SESSION`: \*\*no\*\*/)
    expect(step3).toMatch(/`COCKPIT_STAGE`: `design-qa`/)
  })

  it('its "## Steps" parse for the stage-scope summary, and loadStageScopes finds them for design-qa', async () => {
    expect(parseStageScope(designQa(), null).steps.length).toBeGreaterThan(0)
    const scopes = await loadStageScopes(SKILLS_DIR, CONSTRAINTS_PATH)
    expect(scopes['design-qa']?.steps.length).toBeGreaterThan(0)
  })

  it('does not attempt fixes: those are the designer\'s call and pipelinely-design-fixes\'s job', () => {
    expect(designQa()).toMatch(/Do not attempt fixes/)
  })
})

describe('pipelinely-design-fixes', () => {
  const designFixes = () => skill('pipelinely-design-fixes')

  it('runs in the task\'s own tab: it marks the session working first and never opens a tab or writes TASK.md', () => {
    expect(headingSection(designFixes(), '## Step 0')).toContain('echo "working"')
    expect(designFixes()).not.toMatch(/Write `[^`]*\/TASK\.md`/)
    expect(designFixes()).not.toContain('dispatch-tab.sh')
  })

  it('reads the designer\'s DESIGN_FEEDBACK.md and ends on the design-QA re-run hand-off, without grading its own fix', () => {
    expect(designFixes()).toContain('DESIGN_FEEDBACK.md')
    expect(designFixes()).toContain('waiting: design fixes pushed, ready to re-run design QA')
    expect(designFixes()).toContain('design-fixes <what changed>')
    expect(headingSection(designFixes(), '## Step 5')).toContain('/pipelinely-design-qa <slug>')
  })

  it('its Step headings parse for the stage-scope summary, and loadStageScopes finds them for design-fixes', async () => {
    const scopes = await loadStageScopes(SKILLS_DIR, CONSTRAINTS_PATH)
    expect(scopes['design-fixes']?.steps.length).toBeGreaterThan(0)
  })
})

describe('pipelinely-design-intake', () => {
  const designIntake = () => skill('pipelinely-design-intake')

  it('runs inside the planning worker\'s own tab: it opens no tab, writes no TASK.md and never touches STATUS', () => {
    expect(designIntake()).not.toContain('dispatch-tab.sh')
    expect(designIntake()).not.toMatch(/Write `[^`]*\/TASK\.md`/)
    expect(designIntake()).not.toMatch(/> \S*\/STATUS/)
    expect(designIntake()).toMatch(/never writes `?STATUS`?/i)
  })

  it('writes INTAKE.md and a design-intake TIMELINE line, the two things later stages read', () => {
    expect(designIntake()).toContain('INTAKE.md')
    expect(designIntake()).toContain('design-intake <summary>')
  })

  it('reads the change and finds the code through the Figma MCP, and stops rather than guess when it cannot', () => {
    expect(designIntake()).toContain('Figma MCP')
    expect(designIntake()).toMatch(/never (write|guess)/i)
  })

  it('its Step headings parse as numbered steps for the stage-scope summary', () => {
    expect(parseStageScope(designIntake(), null).steps.length).toBeGreaterThan(0)
  })

  it('is invoked from pipelinely-planning\'s design-change branch, which also writes KIND and never splits into milestones', () => {
    const branch = headingSection(skill('pipelinely-planning'), '## Design-change requests')
    expect(branch).toContain('/pipelinely-design-intake')
    expect(branch).toContain('KIND')
    expect(branch).toContain('## Affected apps')
    expect(branch).toMatch(/never (split|declare)[^.]*milestones/i)
  })
})

describe('pipelinely-adopt', () => {
  const adopt = () => skill('pipelinely-adopt')

  it('is the ds pipeline\'s last stage: it queues the follow-ups, then marks the task done', () => {
    expect(adopt()).toContain('adopt queued <N> items')
    expect(adopt()).toContain('done: adopt queued <N> backlog items')
    expect(adopt()).toContain('done: no apps affected')
  })

  it('reads the apps from the plan\'s "## Affected apps" section and queues one BACKLOG item per app', () => {
    expect(adopt()).toContain('## Affected apps')
    expect(adopt()).toContain('BACKLOG.md')
    expect(adopt()).toContain('- [ ] [<app>] adopt <component> change in <app> (<YYYY-MM-DD>)')
  })

  it('documents a backlog line that formatBacklogItemLine writes and parseBacklogContent reads back', () => {
    const built = formatBacklogItemLine(false, 'web-app', 'adopt Button change in web-app', '2026-10-20')
    expect(built).toEqual({ ok: true, line: '- [ ] [web-app] adopt Button change in web-app (2026-10-20)' })
    const [item] = parseBacklogContent(built.ok ? built.line : '')
    expect(item).toMatchObject({ project: 'web-app', description: 'adopt Button change in web-app', date: '2026-10-20' })
  })

  it('refuses to run for a task that has not merged, and never opens a worktree: the merge removed it', () => {
    expect(adopt()).toContain('merged, ready for adopt')
  })

  it('gates on durable signals, not the STATUS the dispatch overwrites with working', () => {
    const gate = headingSection(adopt(), '## Step 1')
    expect(gate).toContain('merge merged PR #<n>')
    expect(gate).toContain('adopt queued')
    expect(gate).toMatch(/Do not gate on `STATUS`/)
    expect(gate).not.toMatch(/STATUS` reads `waiting/)
    expect(adopt()).toMatch(/no worktree/i)
  })

  it('opens an ephemeral worker-<slug>-adopt tab that does not claim the pointers, with COCKPIT_STAGE adopt', () => {
    const dispatch = headingSection(adopt(), '## Step 3')
    expect(dispatch).toContain('worker-<slug>-adopt')
    expect(dispatch).toMatch(/--claim-pointers no|\*\*no\*\*/)
    expect(dispatch).toMatch(/`COCKPIT_STAGE`: `adopt`/)
  })

  it('its Step headings parse for the stage-scope summary, and loadStageScopes finds them for adopt', async () => {
    const scopes = await loadStageScopes(SKILLS_DIR, CONSTRAINTS_PATH)
    expect(scopes.adopt?.steps.length).toBeGreaterThan(0)
  })
})

describe('orchestrator-prompt.md ds rules', () => {
  const prompt = () => read(ORCHESTRATOR_PROMPT)

  it('step 3 writes KIND=ds for a design-change request, and only then', () => {
    const step3 = orchestratorStep(prompt(), 3)
    expect(step3).toContain('KIND')
    expect(step3).toMatch(/Figma/)
    expect(step3).toMatch(/design[- ]change/i)
  })

  it('lists design-intake and adopt among the TIMELINE stage names', () => {
    const timelineRule = prompt().split('\n').find((line) => line.includes('`<stage>` must be exactly one of')) ?? ''
    expect(timelineRule).toContain('design-intake')
    expect(timelineRule).toContain('adopt')
  })

  it('carries pipelinely-adopt in the Reusable form: the ephemeral-tab list and COCKPIT_STAGE', () => {
    const rows = prompt().split('\n').filter((line) => line.includes('pipelinely-adopt') || line.includes('/ `adopt`'))
    expect(rows.length).toBeGreaterThanOrEqual(2)
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

describe('pipelinely-babysit', () => {
  const babysit = () => skill('pipelinely-babysit')

  it('exists, with frontmatter naming itself and saying it runs in the orchestrator session', () => {
    expect(babysit()).toMatch(/^---\nname: pipelinely-babysit\ndescription: /)
    expect(babysit()).toMatch(/orchestrator's own session/)
    expect(babysit()).toContain('Do NOT open a new tab for yourself')
  })

  it('drives the sweep through the babysit CLI via the tool checkout, one `next` at a time', () => {
    expect(babysit()).toContain(`${TOOL_PREFIX} babysit -- next`)
    for (const command of ['skip-qa', 'note', 'report']) expect(babysit()).toContain(`${TOOL_PREFIX} babysit -- ${command}`)
    expect(babysit()).toContain('--done')
  })

  it('handles every `next` exit code: 0 act, 3 stop, 4 held by load, 1 error', () => {
    const loop = headingSection(babysit(), '## Step 2')
    for (const code of ['Exit `0`', 'Exit `3`', 'Exit `4`', 'Exit `1`']) expect(loop).toContain(code)
  })

  it('records the dispatch AFTER it ran, and never retries a failed one in the same sweep', () => {
    const loop = headingSection(babysit(), '## Step 2')
    expect(loop.indexOf('babysit -- note')).toBeGreaterThan(loop.search(/invoke `?\/cockpit-<skill>/))
    expect(loop).toContain('--failed')
    expect(loop).toMatch(/never retry/i)
  })

  it('single-quotes the free-text failure reason and says what to do when `note` fails', () => {
    const loop = headingSection(babysit(), '## Step 2')
    expect(loop).toMatch(/--failed '<short reason>'/)
    expect(loop).toMatch(/single-quote/i)
    expect(loop).toMatch(/`note` (itself )?(fails|exits)/i)
    expect(headingSection(babysit(), '## Step 3')).toMatch(/--failed '<slug>=<reason>'/)
  })

  // An unattended /loop must never stand in for the developer: whatever a
  // dispatched skill would ask them (pipelinely-dev's weekly-focus "run it anyway
  // or backlog it", a repo choice, a confirmation) stops that task and is
  // listed for them.
  describe("never answers a dispatched skill's own question", () => {
    const dispatchBullet = () => {
      const loop = headingSection(babysit(), '## Step 2')
      return loop.slice(loop.indexOf('`kind` is `dispatch`'), loop.indexOf('`kind` is `skip-qa`'))
    }

    it('has no wording that lets the sweep act as the developer', () => {
      expect(babysit()).not.toMatch(/as if the developer (had )?typed/i)
    })

    it('states the rule as a hard stop in the preamble', () => {
      expect(babysit().split('## Step 1')[0]).toMatch(/never answer[^\n]*on the developer's behalf/i)
    })

    it('says, at the dispatch instruction itself, to stop that task and list it under needs-you', () => {
      expect(dispatchBullet()).toMatch(/never answer/i)
      expect(dispatchBullet()).toMatch(/stop that task/i)
      expect(dispatchBullet()).toContain("--asked '<slug>=<question>'")
      expect(dispatchBullet()).toMatch(/needs-you/)
    })

    it('passes the asked tasks to the report, which lists them under needs-you', () => {
      expect(headingSection(babysit(), '## Step 3')).toContain("--asked '<slug>=<question>'")
    })
  })

  it('supports --except and a single <slug>, and pairs with /loop', () => {
    expect(babysit()).toContain('--except')
    expect(babysit()).toContain('--only <slug>')
    expect(babysit()).toContain('/loop')
  })

  it('ends by printing the CLI report, which is the whole of its output', () => {
    expect(headingSection(babysit(), '## Step 3')).toContain('babysit -- report')
  })

  // The hard stops from the plan, as forbidden strings. A skill that does not
  // contain the command cannot run it; the preamble may *name* what it never
  // does, so this scans only the executable parts (code spans and fences).
  it.each([
    ['merging', /\/pipelinely-merge(?![-\w])|gh pr merge|\/pipelinely-merge(?![-\w])/],
    ['killing sessions', /kill-session|pkill|killall|\bkill\b/],
    ['writing to a worker tab', /send-keys|C-u/],
    ['pushing or publishing', /git push|publish\.sh/],
    ['hand-written STATUS', />\s*\S*\/?STATUS\b|echo [^\n]*STATUS/],
    ['writing SETTINGS.json', />\s*\S*SETTINGS\.json|\btee\b[^\n]*SETTINGS\.json|\bsed\s+-i\b[^\n]*SETTINGS\.json/],
    ['running the e2e suites itself', /playwright test|test:e2e/],
  ])('never instructs %s', (_label, pattern) => {
    const executable = (babysit().match(/```[\s\S]*?```|`[^`\n]+`/g) ?? []).join('\n')
    expect(executable).not.toMatch(pattern)
  })

  it('states the hard stops in a preamble before any step', () => {
    const preamble = babysit().split('## Step 1')[0]
    for (const stop of [/never merge/i, /qaStartPolicy/, /never kill/i, /never write to a worker tab/i, /never edit STATUS/i]) {
      expect(preamble).toMatch(stop)
    }
  })

  it('takes consent from the recorded setting only, never from what was said in the session', () => {
    expect(babysit()).toMatch(/never anything (said|typed) in the session|nothing said in the session/i)
  })

  it('no SKILL.md anywhere tells a session to pkill or killall by name', () => {
    const offenders = allInstructionFiles().filter(({ content }) => /(^|[\s`])(pkill|killall)\s/.test(content)).map(({ name }) => name)
    expect(offenders).toEqual([])
  })

  it('pipelinely-cr and pipelinely-qa take their tmux name from the CLI, so a re-run gets -cr2/-qa2 instead of a collision', () => {
    expect(skill('pipelinely-cr')).toContain(`${TOOL_PREFIX} babysit -- tmux-name worker-<slug>-cr`)
    expect(skill('pipelinely-qa')).toContain(`${TOOL_PREFIX} babysit -- tmux-name worker-<slug>-qa`)
  })

  it('is listed in orchestrator-prompt.md', () => {
    expect(read(ORCHESTRATOR_PROMPT)).toContain('/pipelinely-babysit')
  })

  describe('ships as /pipelinely-babysit', () => {
    it('the npm script is named without "cockpit", so the rename rewrites nothing in the CLI path', () => {
      const scripts = JSON.parse(read(path.join(ROOT, 'package.json'))).scripts as Record<string, string>
      expect(scripts.babysit).toBe('tsx src/babysitCli.ts')
    })
  })
})

describe('weekly-focus gate', () => {
  const GATE_FILES = [
    { name: 'orchestrator-prompt.md', content: () => read(ORCHESTRATOR_PROMPT) },
    { name: 'pipelinely-planning', content: () => skill('pipelinely-planning') },
    { name: 'pipelinely-dev', content: () => skill('pipelinely-dev') },
  ]

  it.each(GATE_FILES)('$name reads the focus through the weekly-focus CLI, which honours the Settings switch', ({ content }) => {
    expect(content()).toContain(`${TOOL_PREFIX} weekly-focus -- get`)
  })

  it.each(GATE_FILES)('$name treats a failing weekly-focus command as an error to report, not as "no focus"', ({ content }) => {
    expect(content()).toMatch(/non-zero exit/)
    expect(content()).toMatch(/don.t treat it as no focus/)
  })

  it.each(GATE_FILES)('$name no longer reads the WEEKLY_FOCUS file directly', ({ content }) => {
    expect(content()).not.toMatch(/Read `\$\{TASKS_DIR[^`]*\/WEEKLY_FOCUS`/)
    expect(content()).not.toMatch(/read: `\$\{TASKS_DIR[^`]*\/WEEKLY_FOCUS`/)
  })
})

describe('pipelinely dashboard introduction', () => {
  const pipelinely = () => skill('pipelinely')
  const intro = () => headingSection(pipelinely(), '## Step 5')
  const MARKER = 'DASHBOARD_INTRO_SEEN'
  const OPEN_COMMAND = 'open http://localhost:3030'

  it('has its own step between starting the server and "Confirm ready", with the numbering consecutive', () => {
    const headings = pipelinely().split('\n').filter((line) => line.startsWith('## Step '))

    expect(headings.map((line) => line.match(/^## Step (\d+)/)![1])).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(headings[3]).toContain('Start the Cockpit dashboard')
    expect(headings[4]).toMatch(/introduce/i)
    expect(headings[5]).toContain('Confirm ready')
  })

  it('orders the work: wait for the server, explain, ask, and only then open', () => {
    const step = intro()
    const positions = [
      step.indexOf('curl -sf'),
      step.indexOf('what the dashboard is'),
      step.indexOf('AskUserQuestion'),
      step.indexOf(OPEN_COMMAND),
    ]

    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('asks one question with Enter on "open", and opens only on that answer', () => {
    const step = intro()

    expect(step).toContain('Open the dashboard in my browser (Recommended)')
    expect(step).toContain("Not now, I'll open it myself")
    expect(step.indexOf('Open the dashboard in my browser (Recommended)')).toBeLessThan(step.indexOf("Not now, I'll open it myself"))
    expect(step).toMatch(/only on the first option/i)
    expect(step).toMatch(/any other answer[^\n]*open nothing/i)
  })

  it('never opens a browser anywhere except as the consented command in the introduction step', () => {
    const outsideIntro = pipelinely().replace(intro(), '')

    expect(outsideIntro).not.toMatch(/\bopen http/)
    expect(outsideIntro).not.toContain('xdg-open')
    // Named only to unset it (Step 4), never assigned or exported.
    expect(pipelinely()).not.toMatch(/COCKPIT_AUTO_OPEN_BROWSER\s*=/)
    for (const line of outsideIntro.split('\n').filter((l) => l.includes('COCKPIT_AUTO_OPEN_BROWSER'))) expect(line).toContain('env -u COCKPIT_AUTO_OPEN_BROWSER')
    expect(intro().match(/xdg-open/g)).toBeNull()
    expect(intro().match(/open http:\/\/localhost:3030/g)).toHaveLength(1)
  })

  it('launches the server with COCKPIT_AUTO_OPEN_BROWSER unset, so a leaked variable cannot open a browser before the question', () => {
    const startStep = headingSection(pipelinely(), '## Step 4')

    expect(startStep).toMatch(/env -u COCKPIT_AUTO_OPEN_BROWSER nohup npm run dev/)
    expect(startStep.indexOf('env -u COCKPIT_AUTO_OPEN_BROWSER')).toBeLessThan(startStep.indexOf('npm run dev'))
  })

  it('bounds every wait try with curl --max-time, so a listener that never responds cannot hang the step', () => {
    const curlLines = intro().split('\n').filter((line) => line.includes('curl '))

    expect(curlLines.length).toBeGreaterThanOrEqual(2)
    for (const line of curlLines) expect(line).toMatch(/--max-time \d+/)
  })

  it('tells the user that Enter opens the dashboard and the other option leaves it closed', () => {
    const explanation = intro().split('\n').find((line) => line.startsWith('3. ')) ?? ''

    expect(explanation).toMatch(/Enter/)
  })

  it('failure path: when the server never answers it prints the log path and opens nothing', () => {
    const step = intro()

    expect(step).toContain('seq 1 30')
    expect(step).toContain('/tmp/cockpit-dashboard.log')
    expect(step).toContain('did not come up')
  })

  it('failure path: without AskUserQuestion it prints the URL and opens nothing', () => {
    expect(intro()).toMatch(/AskUserQuestion[^\n]*unavailable/i)
    expect(intro()).toContain('open it when you are ready')
  })

  it('shows the introduction once: the marker is written only after the answer, and a missing or unwritable marker re-shows it', () => {
    const step = intro()

    expect(step).toContain(MARKER)
    expect(step.indexOf(MARKER)).toBeLessThan(step.indexOf('AskUserQuestion'))
    expect(step.lastIndexOf(MARKER)).toBeGreaterThan(step.indexOf('AskUserQuestion'))
    expect(step).toMatch(/touch "\$INTRO_MARKER" 2>\/dev\/null \|\| echo/)
    expect(step).toContain('Dashboard: http://localhost:3030')
    // A dismissed question is unanswered: no marker, nothing opened.
    expect(step).toMatch(/dismissed or rejected/)
  })

  it('references the marker under the tasks dir only, and the tasks dir ignores it', () => {
    const markerLines = pipelinely().split('\n').filter((line) => line.includes(MARKER))

    expect(markerLines.length).toBeGreaterThan(0)
    for (const line of markerLines) expect(line).not.toMatch(/DASHBOARD_INTRO_[A-Z]*(?<!SEEN)\b/)
    expect(pipelinely()).toContain('${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}')
    // tasks/** is ignored wholesale; the marker must not be allow-listed back in.
    expect(read(path.join(ROOT, '.gitignore'))).not.toContain(MARKER)
  })

  // oss/ is publish tooling that never ships while this test file does, so the
  // published copy has no lib.sh to run the real rewrite with.
  it.skipIf(!fs.existsSync(OSS_LIB_PATH))('survives the real publish-time rewrites: still has the step, the consent order and no stray open', () => {
    const stagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-pipelinely-intro-'))
    try {
      const stagedSkill = path.join(stagedRoot, '.claude', 'skills', 'pipelinely', 'SKILL.md')
      fs.mkdirSync(path.dirname(stagedSkill), { recursive: true })
      fs.writeFileSync(stagedSkill, pipelinely())
      for (const rewrite of ['oss_rewrite_private_paths', 'oss_rewrite_skill_names']) {
        const result = spawnSync('bash', ['-c', `source "$1"; ${rewrite} "$2"`, '_', OSS_LIB_PATH, stagedRoot], { encoding: 'utf8' })
        expect(result.status, result.stderr).toBe(0)
      }
      const published = read(stagedSkill)
      const publishedIntro = headingSection(published, '## Step 5')

      expect(publishedIntro).toContain(MARKER)
      expect(publishedIntro).toContain('$HOME/Dev/pipelinely/tasks')
      expect(publishedIntro.indexOf('AskUserQuestion')).toBeLessThan(publishedIntro.indexOf(OPEN_COMMAND))
      expect(published.replace(publishedIntro, '')).not.toMatch(/\bopen http/)
      expect(headingSection(published, '## Step 4')).toContain('env -u COCKPIT_AUTO_OPEN_BROWSER')
    } finally {
      fs.rmSync(stagedRoot, { recursive: true, force: true })
    }
  })
})

describe('pipeline stage order is taught as dev → CR → CR fixes → QA → QA fixes → merge', () => {
  const PIPELINE_ORDER = 'dev → CR → CR fixes → QA → QA fixes → merge'

  const planReviewSteps = () => headingSection(skill('pipelinely-plan-review'), '## Steps')

  it('the tech-design template tells planning to schedule the Timetable in the pipeline order', () => {
    const timetable = headingSection(read(path.join(ROOT, 'docs', 'tech-design-template.md')), '### Timetable')
    expect(timetable).toContain(PIPELINE_ORDER)
    expect(timetable).not.toMatch(/\bqa, cr\b/i)
  })

  it('pipelinely-dev names CR as the next stage after dev and says DEV_URL is for QA later', () => {
    const devStep = skill('pipelinely-dev').split('\n').find((line) => line.startsWith('3. Once the dev server is up'))
    expect(devStep).toBeDefined()
    expect(devStep).toContain('next stage after dev is CR, not QA')
    expect(devStep).toContain('QA uses it later, after CR')
  })

  it('pipelinely-dev keeps the --watch guidance for the dev server', () => {
    expect(skill('pipelinely-dev')).toContain('`tsx --watch`')
  })

  it('pipelinely-plan-review checks the Timetable order and fixes it in place', () => {
    const steps = planReviewSteps()
    const timetableCheck = steps.split('\n').find((line) => /^\d+\. Check the plan's Timetable section\b/.test(line))
    expect(timetableCheck).toContain(PIPELINE_ORDER)
    expect(steps).toMatch(/\n\d+\. Fix anything wrong by revising `tech-design.md` \*\*in place\*\*/)
  })

  it('pipelinely-plan-review numbers its steps consecutively', () => {
    const numbers = planReviewSteps()
      .split('\n')
      .map((line) => line.match(/^(\d+)\. /)?.[1])
      .filter(Boolean)
      .map(Number)
    expect(numbers).toEqual(numbers.map((_, i) => i + 1))
  })
})

// The dashboard's dispatch buttons type through tmux only, so an orchestrator
// registered outside tmux receives nothing: the registration step has to say
// so up front rather than leave the developer with a 503 on the first click.
describe.each(['pipelinely', 'pipelinely'])('%s warns when the orchestrator is not inside tmux', (skillName) => {
  const registration = () => headingSection(skill(skillName), '## Step 3')

  it('checks $TMUX and prints a warning that names tmux and the orch alias', () => {
    expect(registration()).toMatch(/\[ -z "\$TMUX" \]/)
    expect(registration()).toMatch(/WARNING:[^\n]*tmux[^\n]*`?orch`?/)
  })

  it('no longer promises iTerm-id-only behavior for an orchestrator outside tmux', () => {
    expect(registration()).not.toContain('keeps today')
  })

  it('still records ORCHESTRATOR_TMUX only when $TMUX is set', () => {
    expect(registration()).toContain('[ -n "$TMUX" ] && tmux display-message -p \'#S\' > "$TASKS_DIR_RESOLVED/ORCHESTRATOR_TMUX"')
  })
})
