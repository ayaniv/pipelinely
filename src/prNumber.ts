// Task.reviewRef is a PR URL when the worker recorded one via `gh pr create`,
// but can also be a bare number. Shared by the server (which decides which PR
// number actually gets merged) and the dashboard client (the Open PR and Merge
// actions) — pure, so the browser bundle can import it.
export function parsePrNumberFromReviewRef(ref: string | undefined): string | null {
  if (!ref) return null
  const urlMatch = ref.match(/\/pull\/(\d+)/)
  if (urlMatch) return urlMatch[1]
  return /^\d+$/.test(ref.trim()) ? ref.trim() : null
}
