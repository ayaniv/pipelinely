import fs from 'node:fs/promises'
import path from 'node:path'
import { STAGE_SKILL } from './taskParser.js'
import type { Stage } from './types.js'

export interface StageScope {
  steps: string[]
  constraints: string[]
}

// Single source for stage -> skill dir. 'planning' is never dispatched
// through STAGE_SKILL (see its own comment in taskParser.ts), so it's the
// one explicit entry here; every other stage is derived from STAGE_SKILL's
// own skillName so a renamed skill can't be updated in one map and missed
// in the other. 'merge' has no STAGE_SKILL entry and so never appears here.
export const STAGE_SKILL_DIR: Partial<Record<Stage, string>> = {
  planning: 'pipelinely-planning',
  ...(Object.fromEntries(
    (Object.entries(STAGE_SKILL) as [Stage, { skillName: string }][]).map(([stage, { skillName }]) => [
      stage,
      `pipelinely-${skillName}`,
    ])
  ) as Partial<Record<Stage, string>>),
}

// True column-0 heading lines only — an indented line (nested-fence content,
// a continuation line) never matches, which is what lets the steps-section
// scan stop at the right place even though the template it's reading is
// itself wrapped in a fence that contains a *second*, nested fence.
function sectionBody(text: string, isHeadingStart: (line: string) => boolean): string | null {
  const lines = text.split('\n')
  const startIdx = lines.findIndex(isHeadingStart)
  if (startIdx === -1) return null
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      endIdx = i
      break
    }
  }
  return lines.slice(startIdx + 1, endIdx).join('\n')
}

// Each numbered item's full raw text (its first line plus any indented
// continuation/nested-fence lines that follow, up to the next top-level
// numbered item) — the continuation lines matter for nothing except not
// being mistaken for a new item; leadClause() below only ever surfaces the
// item's own lead clause regardless of how much text follows it.
function extractNumberedItems(body: string): string[] {
  const items: string[] = []
  let current: string[] | null = null
  for (const line of body.split('\n')) {
    const m = /^\d+\.\s+(.*)$/.exec(line)
    if (m) {
      if (current) items.push(current.join('\n'))
      current = [m[1]]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) items.push(current.join('\n'))
  return items
}

function extractStepHeadingTitles(skillMd: string): string[] {
  const titles: string[] = []
  for (const line of skillMd.split('\n')) {
    const m = /^## Step \d+ — (.+)$/.exec(line)
    if (m) titles.push(m[1])
  }
  return titles
}

// Strips a backtick-quoted token to its plain content, converting a
// slash-containing one (a path) to its last path segment — so
// `` `${TASKS_DIR:-…}/<slug>/QA_REPORT.md` `` reads as `QA_REPORT.md`.
function stripBackticks(text: string): string {
  return text.replace(/`([^`]*)`/g, (_, inner: string) => {
    const segments = inner.split('/')
    return segments.length > 1 ? segments[segments.length - 1] : inner
  })
}

// The lead clause of one raw step/heading-title, per tech-design-stage-
// scope-summary.md §1's ordered rules. Order matters: parens must go before
// the cut scan (so a " — "/"e.g." *inside* them can't trigger it), and the
// ", e.g. …"/", i.e. …" clause must be dropped before the cut scan too (so
// a lone trailing period way out at the end of that clause isn't mistaken
// for this item's own sentence end).
function leadClause(raw: string): string {
  let text = raw.replace(/\*\*/g, '')

  while (/\([^()]*\)/.test(text)) {
    text = text.replace(/\([^()]*\)/g, '')
  }

  const egMatch = /,\s*(?:e\.g\.|i\.e\.)\s/i.exec(text)
  if (egMatch) {
    const from = egMatch.index
    // Search for the sentence end *after* the "e.g. "/"i.e. " marker itself
    // — both abbreviations contain periods of their own, which would
    // otherwise look like a (very premature) sentence end.
    const afterMarker = from + egMatch[0].length
    const rest = text.slice(afterMarker)
    const sentenceEnd = /[.?!](?=\s|$)/.exec(rest)
    text = sentenceEnd ? text.slice(0, from) + rest.slice(sentenceEnd.index + 1) : text.slice(0, from)
  }

  // Cut candidates, found on the still-backtick-quoted text so a colon can
  // only cut when it visibly introduces a quoted/formatted example (colon
  // directly before a backtick) rather than a colon used as ordinary
  // mid-sentence English (e.g. "shippability: if merged alone, does…").
  const candidates: { index: number; end: number }[] = []
  const dashIdx = text.indexOf(' — ')
  if (dashIdx !== -1) candidates.push({ index: dashIdx, end: dashIdx })
  const sentenceEndMatch = /[.?!](?=\s|$)/.exec(text)
  if (sentenceEndMatch) {
    const keepMark = text[sentenceEndMatch.index] !== '.'
    candidates.push({ index: sentenceEndMatch.index, end: sentenceEndMatch.index + (keepMark ? 1 : 0) })
  }
  // At least one space is required between the colon and the backtick — a
  // colon with no space before a backtick is just the last character inside
  // an existing backtick-quoted token (e.g. `` `needs:` ``), not a colon
  // introducing a *new* quoted example.
  const colonMatch = /:(?=\s+`)/.exec(text)
  if (colonMatch) candidates.push({ index: colonMatch.index, end: colonMatch.index })

  if (candidates.length) {
    const cut = candidates.reduce((a, b) => (b.index < a.index ? b : a))
    text = text.slice(0, cut.end)
  }

  text = stripBackticks(text)
  text = text.replace(/\s+/g, ' ').replace(/ +([,;:])/g, '$1')
  text = text.trim().replace(/\.$/, '')
  return text
}

const LABEL_BULLET_RE = /^- \*\*(.+?):\*\*/gm

function extractLabels(text: string): string[] {
  return [...text.matchAll(LABEL_BULLET_RE)].map((m) => m[1].trim())
}

function parseConstraints(skillMd: string, engineeringConstraintsMd: string | null): string[] {
  const body = sectionBody(skillMd, (line) => /^## Engineering Constraints\b/.test(line))
  if (body === null) return []

  const inlineLabels = extractLabels(body)
  if (inlineLabels.length) return inlineLabels

  if (body.includes('engineering-constraints.md')) {
    return engineeringConstraintsMd === null ? [] : extractLabels(engineeringConstraintsMd)
  }

  return []
}

export function parseStageScope(skillMd: string, engineeringConstraintsMd: string | null): StageScope {
  const stepsBody = sectionBody(skillMd, (line) => line === '## Steps')
  const steps =
    stepsBody !== null
      ? extractNumberedItems(stepsBody).map(leadClause)
      : extractStepHeadingTitles(skillMd).map(leadClause)

  return { steps, constraints: parseConstraints(skillMd, engineeringConstraintsMd) }
}

export async function loadStageScopes(
  skillsDir: string,
  engineeringConstraintsPath: string
): Promise<Partial<Record<Stage, StageScope | null>>> {
  const constraintsMd = await fs.readFile(engineeringConstraintsPath, 'utf-8').catch((err) => {
    console.error('Failed to read engineering-constraints.md:', err)
    return null
  })

  const result: Partial<Record<Stage, StageScope | null>> = {}
  for (const [stage, dir] of Object.entries(STAGE_SKILL_DIR) as [Stage, string][]) {
    const skillPath = path.join(skillsDir, dir, 'SKILL.md')
    const skillMd = await fs.readFile(skillPath, 'utf-8').catch((err) => {
      console.error(`Failed to read skill for stage ${stage}:`, err)
      return null
    })
    if (skillMd === null) {
      result[stage] = null
      continue
    }

    const scope = parseStageScope(skillMd, constraintsMd)
    if (scope.steps.length === 0) {
      console.error(`Skill for stage ${stage} parsed to zero steps — it may have been reformatted out from under the parser:`, skillPath)
    }
    result[stage] = scope
  }
  return result
}
