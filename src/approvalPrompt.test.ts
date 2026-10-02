import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { detectApprovalPrompt, assignSessionsToTasks, assignSessionsToPollableTasks, SUMMARY_MAX_CHARS, OPTION_LABEL_MAX_CHARS, FINGERPRINT_CONTEXT_LINES } from './approvalPrompt.js'

const PANES_DIR = path.join(__dirname, '..', 'e2e', 'fixtures', 'panes')
const readPane = (session: string) => fs.readFileSync(path.join(PANES_DIR, `${session}.txt`), 'utf8')

const RULE = '─'.repeat(40)

describe('detectApprovalPrompt', () => {
  describe('happy path', () => {
    it('detects an MCP tool dialog with its question and summary', () => {
      const prompt = detectApprovalPrompt(readPane('worker-blocked-approval-mcp'))
      expect(prompt).toEqual({
        question: 'Do you want to proceed?',
        summary: 'Tool use — playwright - browser_navigate(url: "http://127.0.0.1:3030/") (MCP)',
        options: expect.any(Array),
        context: expect.any(Array),
      })
    })

    it('detects a Bash dialog', () => {
      const prompt = detectApprovalPrompt(readPane('worker-blocked-approval-secondary-cr2'))
      expect(prompt?.summary).toBe('Bash command — npx vitest run src/taskParser.test.ts')
    })

    it('detects an edit dialog', () => {
      const pane = [RULE, ' Edit file', '', '   src/x.ts', '', ' Do you want to make this edit to x.ts?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'].join('\n')
      expect(detectApprovalPrompt(pane)?.question).toBe('Do you want to make this edit to x.ts?')
    })

    it('detects the plan-approval dialog with a wrapped question and a described input row', () => {
      const pane = [
        RULE,
        ' Ready to code?',
        '',
        ' Claude has written up a plan and is ready to execute.',
        ' Would you like to proceed?',
        '',
        ' ❯ 1. Yes, and use auto mode',
        '   2. Yes, manually approve edits',
        '   3. No, keep planning',
        '      shift+tab to approve with this feedback',
        '',
        ' Esc to cancel',
      ].join('\n')
      expect(detectApprovalPrompt(pane)?.question).toBe('Claude has written up a plan and is ready to execute. Would you like to proceed?')
    })

    it('detects an AskUserQuestion dialog whose options carry descriptions and whose question has no question mark', () => {
      const pane = [
        RULE,
        ' Which approach',
        '',
        ' Pick the storage layer',
        '',
        ' ❯ 1. SQLite',
        '      Embedded, zero setup',
        '   2. Postgres',
        '      Networked, heavier',
        '',
        ' Esc to cancel',
      ].join('\n')
      expect(detectApprovalPrompt(pane)?.question).toBe('Pick the storage layer')
    })

    it('detects a scrolled list whose visible numbers start above 1', () => {
      const pane = [RULE, ' Pick one', '', ' Choose?', '', '↑ 2. b', '  3. c', '❯ 4. d', '  5. e', '↓ 6. f', '', ' Esc to cancel'].join('\n')
      expect(detectApprovalPrompt(pane)).not.toBeNull()
    })

    it('detects a wrapped option label between two options', () => {
      const pane = [RULE, ' Tool use', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don\'t ask again for a very long', '      command name here', '   3. No', '', ' Esc to cancel'].join('\n')
      expect(detectApprovalPrompt(pane)).not.toBeNull()
    })

    it('strips box borders', () => {
      const pane = [`│ ${RULE} │`, '│  Tool use  │', '│    │', '│  Do you want to proceed?  │', '│  ❯ 1. Yes  │', '│    2. No  │', '│  Esc to cancel  │'].join('\n')
      expect(detectApprovalPrompt(pane)?.question).toBe('Do you want to proceed?')
    })

    it('does not merge an assistant numbered list above a scrolled dialog into the options', () => {
      const prose = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => `  prose ${letter}`)
      const pane = ['  1. earlier list item', ...prose, '', ' Choose?', '', '❯ 2. b', '  3. c', '', ' Esc to cancel'].join('\n')
      expect(detectApprovalPrompt(pane)?.question).toBe('Choose?')
    })

    it('truncates an over-long summary with an ellipsis', () => {
      const longCall = 'x'.repeat(SUMMARY_MAX_CHARS * 2)
      const pane = [RULE, ' Bash command', '', `   ${longCall}`, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n')
      const summary = detectApprovalPrompt(pane)?.summary ?? ''
      expect(summary).toHaveLength(SUMMARY_MAX_CHARS)
      expect(summary.endsWith('…')).toBe(true)
    })

    it('falls back to the question when there is no rule above it', () => {
      const pane = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n')
      expect(detectApprovalPrompt(pane)?.summary).toBe('Do you want to proceed?')
    })
  })

  describe('options', () => {
    it('lists the visible numbers and labels of a permission dialog, pointer stripped', () => {
      const prompt = detectApprovalPrompt(readPane('worker-answer-dialog-perm'))
      expect(prompt?.options.map((option) => option.number)).toEqual([1, 2, 3])
      expect(prompt?.options[0]).toEqual({ number: 1, label: 'Yes' })
      expect(prompt?.options[2].label).toContain('No')
    })

    it('lists plan-approval options and leaves the description line out of the label', () => {
      const pane = [RULE, ' Ready to code?', '', ' Would you like to proceed?', '', ' ❯ 1. Yes, and use auto mode', '   2. Yes, manually approve edits', '   3. No, keep planning', '      shift+tab to approve with this feedback', '', ' Esc to cancel'].join('\n')
      expect(detectApprovalPrompt(pane)?.options).toEqual([
        { number: 1, label: 'Yes, and use auto mode' },
        { number: 2, label: 'Yes, manually approve edits' },
        { number: 3, label: 'No, keep planning' },
      ])
    })

    it('excludes AskUserQuestion descriptions from labels', () => {
      const pane = [RULE, ' Which approach', '', ' Pick the storage layer', '', ' ❯ 1. SQLite', '      Embedded, zero setup', '   2. Postgres', '      Networked, heavier', '', ' Esc to cancel'].join('\n')
      expect(detectApprovalPrompt(pane)?.options).toEqual([{ number: 1, label: 'SQLite' }, { number: 2, label: 'Postgres' }])
    })

    it('lists only the visible options of a scrolled list, in screen order', () => {
      const pane = [RULE, ' Pick one', '', ' Choose?', '', '↑ 2. b', '  3. c', '❯ 4. d', '  5. e', '↓ 6. f', '', ' Esc to cancel'].join('\n')
      expect(detectApprovalPrompt(pane)?.options.map((option) => option.number)).toEqual([2, 3, 4, 5, 6])
    })

    it('caps a long label with an ellipsis', () => {
      const pane = [RULE, ' Tool use', '', ' Proceed?', ' ❯ 1. ' + 'y'.repeat(OPTION_LABEL_MAX_CHARS * 2), '   2. No', '', ' Esc to cancel'].join('\n')
      const label = detectApprovalPrompt(pane)?.options[0].label ?? ''
      expect(label).toHaveLength(OPTION_LABEL_MAX_CHARS)
      expect(label.endsWith('…')).toBe(true)
    })
  })

  describe('context', () => {
    const dialog = ['─'.repeat(40), ' Bash command', '', '   npm test', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel']

    it('is the non-blank lines directly above the dialog top rule, oldest first', () => {
      const pane = ['older output', '', 'line a', 'line b', ...dialog].join('\n')
      expect(detectApprovalPrompt(pane)?.context).toEqual(['older output', 'line a', 'line b'])
    })

    it('keeps at most FINGERPRINT_CONTEXT_LINES lines', () => {
      const above = Array.from({ length: FINGERPRINT_CONTEXT_LINES + 4 }, (_, i) => `out ${i}`)
      const context = detectApprovalPrompt([...above, ...dialog].join('\n'))?.context ?? []
      expect(context).toEqual(above.slice(-FINGERPRINT_CONTEXT_LINES))
    })

    it('is empty when the dialog has no rule above it', () => {
      const pane = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n')
      expect(detectApprovalPrompt(pane)?.context).toEqual([])
    })
  })

  describe('noise (returns null)', () => {
    it('ignores dialog text quoted in scrollback with the input box below', () => {
      expect(detectApprovalPrompt(readPane('worker-blocked-approval-noise'))).toBeNull()
    })

    it('ignores a normal working pane', () => {
      expect(detectApprovalPrompt(readPane('worker-blocked-approval-secondary'))).toBeNull()
    })

    it('ignores a staged prompt under a numbered list ending in a question', () => {
      const pane = ['Which next?', '  1. a', '  2. b', RULE, '❯ 1. run the specs', RULE, '  ? for shortcuts'].join('\n')
      expect(detectApprovalPrompt(pane)).toBeNull()
    })

    it('ignores a numbered list with no pointer', () => {
      expect(detectApprovalPrompt([' Proceed?', '   1. Yes', '   2. No', ' Esc to cancel'].join('\n'))).toBeNull()
    })

    it('ignores pointer options without the cancel footer', () => {
      expect(detectApprovalPrompt([' Proceed?', ' ❯ 1. Yes', '   2. No'].join('\n'))).toBeNull()
    })

    it('ignores non-consecutive numbering', () => {
      expect(detectApprovalPrompt([' Proceed?', ' ❯ 1. Yes', '   3. No', ' Esc to cancel'].join('\n'))).toBeNull()
    })

    it('ignores two pointers', () => {
      expect(detectApprovalPrompt([' Proceed?', ' ❯ 1. Yes', ' ❯ 2. No', ' Esc to cancel'].join('\n'))).toBeNull()
    })

    it('ignores a single option', () => {
      expect(detectApprovalPrompt([' Proceed?', ' ❯ 1. Yes', ' Esc to cancel'].join('\n'))).toBeNull()
    })

    it('ignores an empty or whitespace-only pane', () => {
      expect(detectApprovalPrompt('')).toBeNull()
      expect(detectApprovalPrompt('  \n\n   \n')).toBeNull()
    })
  })
})

describe('assignSessionsToTasks', () => {
  const tasks = [
    { slug: 'foo', tmuxSession: 'worker-foo' },
    { slug: 'foo-bar', tmuxSession: null },
    { slug: 'custom', tmuxSession: 'my-own-session' },
  ]

  it('maps the primary and secondary sessions to their task', () => {
    const map = assignSessionsToTasks(['worker-foo', 'worker-foo-cr2', 'worker-foo-devurl', 'worker-foo-review'], tasks)
    expect([...map.values()]).toEqual(['foo', 'foo', 'foo', 'foo'])
  })

  it('gives a prefix collision to the longest slug', () => {
    expect(assignSessionsToTasks(['worker-foo-bar', 'worker-foo-bar-cr'], tasks).get('worker-foo-bar-cr')).toBe('foo-bar')
  })

  it('drops the orchestrator and other claude sessions', () => {
    expect(assignSessionsToTasks(['claude-1', 'claude-orchestrator'], tasks).size).toBe(0)
  })

  it('does not match a session that merely shares a name prefix', () => {
    expect(assignSessionsToTasks(['worker-foobar'], tasks).size).toBe(0)
  })

  it('honours a TMUX_SESSION with a non-worker name', () => {
    expect(assignSessionsToTasks(['my-own-session'], tasks).get('my-own-session')).toBe('custom')
  })
})

describe('assignSessionsToPollableTasks', () => {
  const tasks = [
    { slug: 'foo', status: 'working' as const, tmuxSession: null },
    { slug: 'foo-bar', status: 'done' as const, tmuxSession: null },
    { slug: 'shelf', status: 'shelved' as const, tmuxSession: 'my-shelved-session' },
  ]

  it('keeps the sessions of pollable tasks', () => {
    expect(assignSessionsToPollableTasks(['worker-foo', 'worker-foo-cr'], tasks)).toEqual(new Map([['worker-foo', 'foo'], ['worker-foo-cr', 'foo']]))
  })

  it("never gives a done task's lingering session to an active task with a shorter slug", () => {
    expect(assignSessionsToPollableTasks(['worker-foo-bar', 'worker-foo-bar-cr'], tasks).size).toBe(0)
  })

  it('drops a session a shelved task names as its TMUX_SESSION', () => {
    expect(assignSessionsToPollableTasks(['my-shelved-session'], tasks).size).toBe(0)
  })
})
