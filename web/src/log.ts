// The one logger shape passed around the data and action modules — every
// call site hands in `console.error` in production, matching the repo's own
// console.error logging convention (there is no
// analytics abstraction here).
export type Logger = (message: string, ...args: unknown[]) => void
