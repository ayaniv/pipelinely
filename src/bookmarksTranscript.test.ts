import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findTranscriptPath, lastAssistantAnswer } from './bookmarksTranscript.js'

// Bookmarks M0 — how `/pipelinely-bookmark` saves "the last answer" verbatim.
// The skill runs as its own turn, so by the time the CLI reads the
// transcript the newest user prompt is the `/pipelinely-bookmark` invocation itself and
// the newest assistant text is the skill's own chatter. The answer the
// developer means is the turn *before* that prompt.
//
// Every transcript line here is invented and only carries the fields the
// parser reads. No real session transcript is read or copied — see the
// task's safety rules. Written red during planning.

const SESSION_ID = '0b5e2c1a-7d3f-4e8a-9c21-5f6a7b8c9d0e'

function jsonl(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

const prompt = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra })
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'assistant', message: { role: 'assistant', content }, ...extra })
const toolResult = () => prompt([{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }])
const text = (value: string) => ({ type: 'text', text: value })
const toolUse = () => ({ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'true' } })
const BOOKMARK_PROMPT = prompt('<command-name>/pipelinely-bookmark</command-name>\n<command-args></command-args>')

describe('lastAssistantAnswer', () => {
  it('returns the whole previous turn, joined across tool calls, not the /pipelinely-bookmark turn', () => {
    const transcript = jsonl([
      prompt('How should I name the store?'),
      assistant([{ type: 'thinking', thinking: 'hidden reasoning' }, text('First part.'), toolUse()]),
      toolResult(),
      assistant([text('Second part.')]),
      BOOKMARK_PROMPT,
      assistant([text('Saving that as a bookmark.'), toolUse()]),
    ])

    expect(lastAssistantAnswer(transcript)).toBe('First part.\n\nSecond part.')
  })

  it('keeps the answer byte-for-byte (markdown, code fences, trailing spaces)', () => {
    const answer = '## Heading\n\n```ts\nconst a = 1  \n```\n\n- item *one*'
    const transcript = jsonl([prompt('q'), assistant([text(answer)]), BOOKMARK_PROMPT])
    expect(lastAssistantAnswer(transcript)).toBe(answer)
  })

  it('ignores sub-agent (sidechain) entries and injected meta prompts', () => {
    const transcript = jsonl([
      prompt('q'),
      assistant([text('Main answer.')]),
      assistant([text('A sub-agent said this.')], { isSidechain: true }),
      prompt('skill instructions injected by Claude Code', { isMeta: true }),
      BOOKMARK_PROMPT,
    ])
    expect(lastAssistantAnswer(transcript)).toBe('Main answer.')
  })

  it('treats a compaction summary as injected, not as the prompt that bounds the answer', () => {
    const transcript = jsonl([
      prompt('q'),
      assistant([text('Answer before the summary.')]),
      prompt('This session is being continued from a previous conversation…', { isCompactSummary: true }),
      BOOKMARK_PROMPT,
    ])
    expect(lastAssistantAnswer(transcript)).toBe('Answer before the summary.')
  })

  it('skips malformed lines instead of failing the whole read', () => {
    const transcript = `${JSON.stringify(prompt('q'))}\nnot json at all\n${JSON.stringify(assistant([text('Answer.')]))}\n${JSON.stringify(BOOKMARK_PROMPT)}\n`
    expect(lastAssistantAnswer(transcript)).toBe('Answer.')
  })

  it('returns null when there is no earlier answer to save', () => {
    expect(lastAssistantAnswer(jsonl([BOOKMARK_PROMPT, assistant([text('Saving…')])]))).toBeNull()
    expect(lastAssistantAnswer('')).toBeNull()
  })

  it('returns null when the previous turn was tool calls only, with no text', () => {
    const transcript = jsonl([prompt('q'), assistant([toolUse()]), toolResult(), BOOKMARK_PROMPT])
    expect(lastAssistantAnswer(transcript)).toBeNull()
  })
})

describe('findTranscriptPath', () => {
  let projectsDir: string

  beforeEach(() => {
    projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-bookmarks-projects-'))
  })

  afterEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true })
  })

  // A worker launches in the task dir and later cds into its worktree, so
  // the project folder can't be derived from the current cwd; it is found by
  // the session id across every project folder instead.
  it('finds the session file in whichever project folder holds it', async () => {
    const projectFolder = path.join(projectsDir, '-invented-launch-dir')
    fs.mkdirSync(projectFolder)
    fs.mkdirSync(path.join(projectsDir, '-another-project'))
    fs.writeFileSync(path.join(projectFolder, `${SESSION_ID}.jsonl`), '')

    expect(await findTranscriptPath(projectsDir, SESSION_ID)).toBe(path.join(projectFolder, `${SESSION_ID}.jsonl`))
  })

  it('returns null when no project folder holds that session', async () => {
    fs.mkdirSync(path.join(projectsDir, '-invented-launch-dir'))
    expect(await findTranscriptPath(projectsDir, SESSION_ID)).toBeNull()
  })

  it('returns null when the projects folder does not exist', async () => {
    expect(await findTranscriptPath(path.join(projectsDir, 'missing'), SESSION_ID)).toBeNull()
  })

  it('refuses a session id that could escape the projects folder', async () => {
    await expect(findTranscriptPath(projectsDir, '../../etc/passwd')).rejects.toThrow()
  })
})
