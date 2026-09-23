import fs from 'node:fs/promises'

// Backs src/docsGuide.test.ts's guard against docs/user-guide.md rotting
// out of sync with the skill set, and against renderer drift — the same
// file renders through the dashboard's renderMarkdownToHtml and through
// pipelinely-marketing's react-markdown (no remark-gfm), so it has to stay
// inside the intersection of both. See tech-design-pipelinely-docs.md §5.

// Only an inline-code span whose first token is /<name> counts — a bare
// path in prose (not inside backticks), like a URL's /docs, never matches
// this regex at all, so it's excluded by construction rather than by an
// extra rule.
const SKILL_REF_RE = /`\/([a-zA-Z0-9-]+)(?:\s[^`]*)?`/g

export function extractSkillReferences(guideMd: string): string[] {
  const names = new Set<string>()
  for (const match of guideMd.matchAll(SKILL_REF_RE)) names.add(match[1])
  return [...names]
}

// Directories excluded from publish by a "!.claude/skills/<name>/" line in
// oss/allowlist.txt. Read only if that file exists: in pipelinely, oss/ is
// never published, so the file is absent there and every directory that IS
// present was already published (the exclusion took effect once, at publish
// time, by never copying the directory over) — one rule gives the right
// answer in both repos.
export async function listPublishedSkillDirs(skillsDir: string, allowlistPath: string): Promise<string[]> {
  const entries = await fs.readdir(skillsDir, { withFileTypes: true })
  const allDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)

  const allowlist = await fs.readFile(allowlistPath, 'utf-8').catch(() => null)
  if (allowlist === null) return allDirs

  // Trailing content after the path (a "# why" comment, in this repo's own
  // oss/allowlist.txt) is allowed — only the "!.claude/skills/<name>/"
  // prefix itself is significant.
  const excluded = new Set(
    [...allowlist.matchAll(/^!\.claude\/skills\/([^/\s]+)\//gm)].map((m) => m[1])
  )
  return allDirs.filter((name) => !excluded.has(name))
}

export interface GuideViolation {
  rule: string
  line: number
  detail: string
}

// Blanks out fenced code block bodies (keeping line numbers stable) so the
// structural rules below — tables, nested lists, blockquotes, images,
// heading formatting — never fire on a code example that merely looks like
// one of those things.
function blankFencedCode(markdown: string): string {
  const lines = markdown.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return ''
      }
      return inFence ? '' : line
    })
    .join('\n')
}

const TABLE_ROW_RE = /^\s*\|/
const NESTED_LIST_ITEM_RE = /^[ \t]+([-*]|\d+\.)\s/
const BLOCKQUOTE_RE = /^\s*>/
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/
const HEADING_RE = /^##\s+(.*)$/
const HEADING_FORMATTING_RE = /[`*_[]/
const LINK_RE = /\[[^\]]+\]\(([^)]+)\)/g
const PRIVATE_REPO_NAME_RE = /cockpit-ai/i
const BANNED_LINK_PATH_RE = /\/pipelinely-feedback\b|\/pipelinely-handover\b/

export function findWrittenSubsetViolations(markdown: string): GuideViolation[] {
  const violations: GuideViolation[] = []

  const structural = blankFencedCode(markdown).split('\n')
  structural.forEach((line, idx) => {
    const n = idx + 1
    if (TABLE_ROW_RE.test(line)) violations.push({ rule: 'no-tables', line: n, detail: line.trim() })
    if (NESTED_LIST_ITEM_RE.test(line)) violations.push({ rule: 'no-nested-lists', line: n, detail: line.trim() })
    if (BLOCKQUOTE_RE.test(line)) violations.push({ rule: 'no-blockquotes', line: n, detail: line.trim() })
    if (IMAGE_RE.test(line)) violations.push({ rule: 'no-images', line: n, detail: line.trim() })

    const heading = line.match(HEADING_RE)
    if (heading && HEADING_FORMATTING_RE.test(heading[1])) {
      violations.push({ rule: 'plain-heading-text', line: n, detail: line.trim() })
    }
  })

  // Link shape and the private-repo-name ban apply everywhere, including
  // inside a fenced example — a code sample must never leak a private path
  // or a non-https link either.
  markdown.split('\n').forEach((line, idx) => {
    const n = idx + 1
    if (PRIVATE_REPO_NAME_RE.test(line)) {
      violations.push({ rule: 'no-private-repo-name', line: n, detail: line.trim() })
    }
    for (const match of line.matchAll(LINK_RE)) {
      const href = match[1]
      if (!/^https:\/\//.test(href)) {
        violations.push({ rule: 'links-must-be-absolute-https', line: n, detail: href })
      } else if (BANNED_LINK_PATH_RE.test(href)) {
        violations.push({ rule: 'no-feedback-or-handover-link-path', line: n, detail: href })
      }
    }
  })

  return violations
}
