import { describe, it, expect } from 'vitest'
import { composeBatchMessage, renderBacklogProjectClause } from './batchDispatch.js'

// composeBatchMessage is the one place the no-auto-submit safety property
// actually depends on: its output is typed straight into the developer's
// live orchestrator session via stageInSession, so "unusable input becomes
// null" has to hold for malformed input, not only empty input — and "the
// result never contains a newline" has to hold unconditionally, since an
// embedded \n reaches iTerm2 as a real LF keystroke (see focusTab.ts's
// escapeForAppleScriptString), which is a submit.

describe('composeBatchMessage', () => {
  it('composes a wave batch of 2 slugs as one numbered, parallel line', () => {
    const message = composeBatchMessage({
      kind: 'wave',
      slugs: ['pipelinely-dashboard-redesign-m2', 'pipelinely-dashboard-redesign-m3'],
    })
    expect(message).toBe(
      'Dispatch these 2 milestones in parallel: ' +
      '(1) /pipelinely-dev pipelinely-dashboard-redesign-m2; ' +
      '(2) /pipelinely-dev pipelinely-dashboard-redesign-m3',
    )
  })

  it('composes a wave batch of 1 slug with the singular stem and no numbering', () => {
    const message = composeBatchMessage({ kind: 'wave', slugs: ['pipelinely-dashboard-redesign-m2'] })
    expect(message).toBe('Dispatch this milestone: /pipelinely-dev pipelinely-dashboard-redesign-m2')
  })

  it('composes a backlog batch of 3 items, numbered, in order, contexts joined with —', () => {
    const message = composeBatchMessage({
      kind: 'backlog',
      items: [
        { description: 'First item', context: 'its context' },
        { description: 'Second item' },
        { description: 'Third item' },
      ],
    })
    expect(message).toBe(
      'Dispatch these 3 backlog items in parallel: ' +
      '(1) First item — its context; (2) Second item; (3) Third item',
    )
  })

  it('composes a backlog batch of 1 item with the singular stem, still carrying "backlog item"', () => {
    const message = composeBatchMessage({
      kind: 'backlog',
      items: [{ description: 'First item', context: 'its context' }],
    })
    expect(message).toBe('Dispatch this backlog item: First item — its context')
  })

  it('collapses an item context containing a line break — the result contains no \\n', () => {
    const message = composeBatchMessage({
      kind: 'backlog',
      items: [{ description: 'First item', context: 'line one\nline two' }],
    })
    expect(message).not.toBeNull()
    expect(message).not.toContain('\n')
  })

  it('returns null for an empty slugs array', () => {
    expect(composeBatchMessage({ kind: 'wave', slugs: [] })).toBeNull()
  })

  it('returns null for an empty items array', () => {
    expect(composeBatchMessage({ kind: 'backlog', items: [] })).toBeNull()
  })

  it('returns null when a slug fails SAFE_TOKEN', () => {
    expect(composeBatchMessage({ kind: 'wave', slugs: ['not a valid slug'] })).toBeNull()
  })

  it('returns null for a blank/whitespace-only description', () => {
    expect(composeBatchMessage({ kind: 'backlog', items: [{ description: '   ' }] })).toBeNull()
  })

  it('returns null for an unknown kind', () => {
    expect(composeBatchMessage({ kind: 'bogus', slugs: ['a'] })).toBeNull()
  })

  it('returns null when the body is not an object at all — null', () => {
    expect(composeBatchMessage(null)).toBeNull()
  })

  it('returns null when the body is not an object at all — a string', () => {
    expect(composeBatchMessage('wave')).toBeNull()
  })

  it('returns null when the body is not an object at all — an array', () => {
    expect(composeBatchMessage(['wave'])).toBeNull()
  })

  it('returns null when slugs is present but not an array', () => {
    expect(composeBatchMessage({ kind: 'wave', slugs: 'not-an-array' })).toBeNull()
  })

  it('returns null when items is present but not an array', () => {
    expect(composeBatchMessage({ kind: 'backlog', items: 'not-an-array' })).toBeNull()
  })

  it('returns null, never [object Object], when a slugs element is not a string', () => {
    expect(composeBatchMessage({ kind: 'wave', slugs: [{}] })).toBeNull()
  })

  it('returns null, never [object Object], when an items element is not an object', () => {
    expect(composeBatchMessage({ kind: 'backlog', items: ['not-an-object'] })).toBeNull()
  })

  it('drops a non-string context on an otherwise valid item rather than failing', () => {
    const message = composeBatchMessage({
      kind: 'backlog',
      items: [{ description: 'First item', context: 42 }],
    })
    expect(message).toBe('Dispatch this backlog item: First item')
  })

  it('prefixes a tagged backlog item with its project', () => {
    const message = composeBatchMessage({
      kind: 'backlog',
      items: [{ description: 'First item', project: 'cockpit-ai' }],
    })
    expect(message).toBe('Dispatch this backlog item: [cockpit-ai] First item')
  })

  it('an untagged backlog item message is byte-identical to today\'s', () => {
    const message = composeBatchMessage({
      kind: 'backlog',
      items: [{ description: 'First item', context: 'its context' }],
    })
    expect(message).toBe('Dispatch this backlog item: First item — its context')
  })

  it('returns null when a backlog item project fails isBacklogProject', () => {
    expect(composeBatchMessage({
      kind: 'backlog',
      items: [{ description: 'First item', project: 'not a slug' }],
    })).toBeNull()
  })
})

describe('renderBacklogProjectClause', () => {
  it('renders a clause for a project', () => {
    expect(renderBacklogProjectClause('cockpit-ai')).toBe(' (project: cockpit-ai)')
  })

  it('renders nothing for null', () => {
    expect(renderBacklogProjectClause(null)).toBe('')
  })

  it('renders nothing for undefined', () => {
    expect(renderBacklogProjectClause(undefined)).toBe('')
  })
})
