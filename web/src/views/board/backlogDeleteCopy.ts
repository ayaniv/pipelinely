import type { BacklogItem } from '../../../../src/types'

export interface BacklogDeleteCopy {
  headline: string
  body: string
}

// The only place the singular/plural and shelved wording lives. A shelved
// row's body keeps the more precise note: its task directory and branch stay
// on disk, only the backlog entry (and with it the Resume button) goes away.
// Batch selections never include a shelved row (it has no checkbox), so that
// wording only ever applies to a single-item row deletion.
export function backlogDeleteCopy(items: BacklogItem[]): BacklogDeleteCopy {
  const headline = items.length === 1 ? 'Delete 1 backlog item?' : `Delete ${items.length} backlog items?`
  if (items.length === 1 && items[0].shelvedSlug) {
    return {
      headline,
      body: `Its task directory (${items[0].shelvedSlug}) and branch stay on disk — only this entry, and with it the Resume button, goes away.`,
    }
  }
  return { headline, body: items.length === 1 ? 'This removes it from the backlog permanently.' : 'This removes them from the backlog permanently.' }
}
