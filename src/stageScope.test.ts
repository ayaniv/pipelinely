import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseStageScope, loadStageScopes, STAGE_SKILL_DIR } from './stageScope.js'

// Fixture strings mirror the two real skill shapes (see tech-design-
// stage-scope-summary.md's table): a templated dispatch skill, whose real
// scope lives inside a fenced TASK.md template's own `## Steps` list (not
// the outer `## Step N — …` dispatch-mechanics headings), and an in-tab
// skill with no template, whose outer `## Step N — <title>` headings ARE
// the scope.
const TEMPLATED_SKILL = `---
name: cockpit-fixture
description: fixture
---

# Cockpit Fixture

## Step 1 — Resolve the slug

Some dispatch mechanics prose, not the real scope.

## Step 2 — Write \`TASK.md\`

Write \`TASK.md\`:

\`\`\`
# <Task title>

## Steps
1. Run the tests and confirm they fail first.
2. Implement until green, with a nested example:
   \`\`\`
   ## Milestones
   - M0: Foundation — needs: none
   \`\`\`
3. Open a PR.

## Engineering Constraints (required)
- **Test coverage:** cover all new functionality with tests.
- **Error observability:** handle and log fallible operations.

## Output
The PR.
\`\`\`

## Step 3 — Open the tab

Dispatch mechanics, not scope.
`

const POINTER_CONSTRAINTS_SKILL = `---
name: cockpit-fixture-pointer
description: fixture
---

# Cockpit Fixture Pointer

## Step 1 — Write \`TASK.md\`

\`\`\`
# <Task title>

## Steps
1. Do the one thing.

## Engineering Constraints (required)
Before writing \`TASK.md\`, read \`\${REPOS_DIR:-$HOME/Dev}/pipelinely/docs/engineering-constraints.md\` and copy its bullet list verbatim into this section.

## Output
The PR.
\`\`\`
`

const NO_CONSTRAINTS_SKILL = `---
name: cockpit-fixture-none
description: fixture
---

## Step 1 — Write \`TASK.md\`

\`\`\`
# <Task title>

## Steps
1. Do the one thing.

## Output
The PR.
\`\`\`
`

const IN_TAB_SKILL = `---
name: cockpit-fixture-in-tab
description: fixture
---

# Cockpit Fixture In Tab

## Step 1 — Read the triage selection

Read the file.

## Step 2 — Fix each checked case

Fix it.

## Step 3 — Commit, push, and report

Ship it.
`

const ZERO_STEPS_SKILL = `---
name: cockpit-fixture-zero
description: fixture
---

# Cockpit Fixture Zero

Some prose with no recognizable steps section at all.
`

const CONSTRAINTS_FILE = `# Engineering constraints

- **Test coverage:** cover all new functionality with tests for both happy and failure paths.
- **Error observability:** any fallible operation must handle and log errors.
- **Conventions:** follow the target repo's existing patterns.
`

describe('parseStageScope', () => {
  it('reads steps from the fenced ## Steps list, not the outer ## Step N — headings', () => {
    const scope = parseStageScope(TEMPLATED_SKILL, null)
    expect(scope.steps).toEqual([
      'Run the tests and confirm they fail first',
      'Implement until green, with a nested example',
      'Open a PR',
    ])
  })

  it('does not truncate the list or leak fence content when a step embeds a nested fence', () => {
    const scope = parseStageScope(TEMPLATED_SKILL, null)
    expect(scope.steps).toHaveLength(3)
    expect(scope.steps.some(s => s.includes('Milestones'))).toBe(false)
    expect(scope.steps.some(s => s.includes('```'))).toBe(false)
  })

  it('reads steps from ## Step N — <title> headings for an in-tab skill with no template', () => {
    const scope = parseStageScope(IN_TAB_SKILL, null)
    expect(scope.steps).toEqual([
      'Read the triage selection',
      'Fix each checked case',
      'Commit, push, and report',
    ])
  })

  it('reads inline "- **Label:**" constraint bullets straight from the template', () => {
    const scope = parseStageScope(TEMPLATED_SKILL, null)
    expect(scope.constraints).toEqual(['Test coverage', 'Error observability'])
  })

  it('resolves a "copy verbatim" constraints pointer against the engineering-constraints.md content', () => {
    const scope = parseStageScope(POINTER_CONSTRAINTS_SKILL, CONSTRAINTS_FILE)
    expect(scope.constraints).toEqual(['Test coverage', 'Error observability', 'Conventions'])
  })

  it('resolves a pointer to [] when the constraints file content is null', () => {
    const scope = parseStageScope(POINTER_CONSTRAINTS_SKILL, null)
    expect(scope.constraints).toEqual([])
  })

  it('returns [] when the skill has no Engineering Constraints section at all', () => {
    const scope = parseStageScope(NO_CONSTRAINTS_SKILL, CONSTRAINTS_FILE)
    expect(scope.constraints).toEqual([])
  })

  it('returns zero steps for a skill with no recognizable steps section', () => {
    const scope = parseStageScope(ZERO_STEPS_SKILL, null)
    expect(scope.steps).toEqual([])
  })

  // Lead-clause rules, one case per rule (see tech-design-stage-scope-
  // summary.md §1). Fixture text mirrors the real shape each rule exists
  // to handle, without pinning real skill prose (that's the real-files
  // test below, which asserts shape only).
  describe('lead-clause extraction', () => {
    const stepScope = (stepLine: string) =>
      parseStageScope(
        `---\nname: fixture\ndescription: fixture\n---\n\n## Step 1 — Write TASK.md\n\n\`\`\`\n# <Task title>\n\n## Steps\n1. ${stepLine}\n\n## Output\nThe PR.\n\`\`\`\n`,
        null
      ).steps[0]

    it('strips bold markers', () => {
      expect(stepScope('Name a **real, confirmed** verifier.')).toBe('Name a real, confirmed verifier')
    })

    it('drops a parenthetical group entirely', () => {
      expect(stepScope('Run the tests (or the named verifier) and confirm they pass.')).toBe(
        'Run the tests and confirm they pass'
      )
    })

    it('drops a nested pair of parens, including a dash inside them', () => {
      expect(stepScope('Do the thing (see the note (with an inner aside — detail) here) now.')).toBe(
        'Do the thing now'
      )
    })

    it('drops an "e.g." clause inside parens without treating it as a cut point', () => {
      expect(stepScope('Ship the change (e.g. a patch release) today.')).toBe('Ship the change today')
    })

    it('converts a slash-containing backtick path token to its basename', () => {
      expect(stepScope('Write `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/QA_REPORT.md` now.')).toBe(
        'Write QA_REPORT.md now'
      )
    })

    it('drops a ", e.g. …" clause outside parens, through the end of its sentence', () => {
      expect(
        stepScope("Append a round note, e.g. `round 2: tightened M4's needs`, when revising.")
      ).toBe('Append a round note')
    })

    it('drops a ", i.e. …" clause the same way', () => {
      expect(stepScope('Use the base branch, i.e. the one PRs merge into, as the target.')).toBe(
        'Use the base branch'
      )
    })

    it('leaves no stray space before a comma after a dropped parenthetical', () => {
      expect(stepScope('Write tech-design.md (with a Milestones section), commit it.')).toBe(
        'Write tech-design.md, commit it'
      )
    })

    it('cuts at " — " and does not carry the rest of the sentence along', () => {
      expect(
        stepScope('Name a real verifier — a command that actually exists in this repo.')
      ).toBe('Name a real verifier')
    })

    it('cuts at a question mark, keeping the mark itself', () => {
      expect(
        stepScope('Check it builds on its own? This is the crux of the review.')
      ).toBe('Check it builds on its own?')
    })

    it('cuts at a period and drops the period itself', () => {
      expect(stepScope('Write the report. Then move on to the next step.')).toBe('Write the report')
    })

    it('cuts at a trailing colon that introduces a backtick-quoted example', () => {
      expect(
        stepScope('Write the report in this exact format: `n of m cases failed`, then list them.')
      ).toBe('Write the report in this exact format')
    })

    it('keeps a colon that is mid-sentence English, not a colon-before-backtick', () => {
      expect(
        stepScope('Check shippability: if merged alone, does it still build on its own?')
      ).toBe('Check shippability: if merged alone, does it still build on its own?')
    })
  })
})

describe('loadStageScopes', () => {
  it('loads every stage in STAGE_SKILL_DIR against the real .claude/skills and docs/engineering-constraints.md, and never includes merge', async () => {
    const skillsDir = path.join(process.cwd(), '.claude', 'skills')
    const constraintsPath = path.join(process.cwd(), 'docs', 'engineering-constraints.md')

    const scopes = await loadStageScopes(skillsDir, constraintsPath)

    for (const stage of Object.keys(STAGE_SKILL_DIR)) {
      expect(scopes[stage as keyof typeof scopes], `scope for ${stage}`).toBeTruthy()
      expect(scopes[stage as keyof typeof scopes]!.steps.length, `steps for ${stage}`).toBeGreaterThan(0)
    }
    expect(scopes.dev!.constraints.length).toBeGreaterThan(0)
    expect(scopes).not.toHaveProperty('merge')
  })

  describe('failure paths', () => {
    let tmpDir: string
    let skillsDir: string
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stagescope-test-'))
      skillsDir = path.join(tmpDir, 'skills')
      for (const dir of Object.values(STAGE_SKILL_DIR)) {
        await fs.mkdir(path.join(skillsDir, dir as string), { recursive: true })
        await fs.writeFile(path.join(skillsDir, dir as string, 'SKILL.md'), IN_TAB_SKILL)
      }
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(async () => {
      consoleErrorSpy.mockRestore()
      await fs.rm(tmpDir, { recursive: true, force: true })
    })

    it('logs and reports null for one stage whose SKILL.md is missing, while the others still load', async () => {
      await fs.rm(path.join(skillsDir, STAGE_SKILL_DIR['dev']!), { recursive: true, force: true })
      const constraintsPath = path.join(tmpDir, 'engineering-constraints.md')
      await fs.writeFile(constraintsPath, CONSTRAINTS_FILE)

      const scopes = await loadStageScopes(skillsDir, constraintsPath)

      expect(scopes.dev).toBeNull()
      expect(scopes.planning).toBeTruthy()
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('dev'), expect.anything())
    })

    it('logs and parses dev with empty constraints when the constraints file is missing', async () => {
      await fs.writeFile(path.join(skillsDir, STAGE_SKILL_DIR['dev']!, 'SKILL.md'), POINTER_CONSTRAINTS_SKILL)
      const constraintsPath = path.join(tmpDir, 'does-not-exist.md')

      const scopes = await loadStageScopes(skillsDir, constraintsPath)

      expect(consoleErrorSpy).toHaveBeenCalled()
      expect(scopes.dev!.constraints).toEqual([])
    })

    it('logs when a SKILL.md parses to zero steps', async () => {
      await fs.writeFile(path.join(skillsDir, STAGE_SKILL_DIR['dev']!, 'SKILL.md'), ZERO_STEPS_SKILL)
      const constraintsPath = path.join(tmpDir, 'engineering-constraints.md')
      await fs.writeFile(constraintsPath, CONSTRAINTS_FILE)

      const scopes = await loadStageScopes(skillsDir, constraintsPath)

      expect(scopes.dev!.steps).toEqual([])
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('dev'), expect.anything())
    })
  })
})
