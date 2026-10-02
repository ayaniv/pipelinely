// Backs src/privacyWording.test.ts's guard on user-facing privacy copy. The
// product's honest claim is narrow: no Pipelinely server receives code,
// sessions or pipeline state, while Claude Code still talks to Anthropic and
// git/gh to GitHub. The phrases below over-promise past that, so they must
// not reappear in anything the product ships.

export interface PrivacyWordingHit {
  rule: string
  line: number
  detail: string
}

const BANNED_PHRASES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: 'no-local-only', pattern: /\blocal[- ]only\b/i },
  { rule: 'no-nothing-leaves', pattern: /\bnothing leaves\b/i },
  { rule: 'no-offline', pattern: /\boffline\b/i },
  { rule: 'no-no-network', pattern: /\bno network\b/i },
  { rule: 'no-private', pattern: /\bprivate\b/i },
]

export function findBannedPrivacyPhrases(text: string): PrivacyWordingHit[] {
  const hits: PrivacyWordingHit[] = []
  text.split('\n').forEach((line, idx) => {
    for (const { rule, pattern } of BANNED_PHRASES) {
      if (pattern.test(line)) hits.push({ rule, line: idx + 1, detail: line.trim() })
    }
  })
  return hits
}

// The `## Privacy` heading through to the next `## ` heading. Required
// statements are checked against this alone: the loopback and PIPELINELY_HOST
// words also appear in the Network access section, so a whole-file check
// would keep passing with the Privacy section deleted.
export function extractPrivacySection(markdown: string): string {
  const match = markdown.match(/^## Privacy[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)
  return match ? match[0] : ''
}

const REQUIRED_STATEMENTS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'no-pipelinely-servers', pattern: /no\s+pipelinely\s+servers?\b/i },
  { id: 'anthropic-and-github', pattern: /(?=[\s\S]*\banthropic\b)(?=[\s\S]*\bgithub\b)/i },
  { id: 'loopback-binding', pattern: /(?=[\s\S]*127\.0\.0\.1)(?=[\s\S]*PIPELINELY_HOST)/ },
]

export function missingPrivacyStatements(text: string): string[] {
  return REQUIRED_STATEMENTS.filter(({ pattern }) => !pattern.test(text)).map(({ id }) => id)
}
