import fs from 'node:fs/promises'
import path from 'node:path'
import { isSessionId } from './bookmarks.js'

// Reads only the calling session's own transcript, only when the developer
// runs /pipelinely-bookmark. Claude Code's transcript shape is not a
// published contract, so every unrecognised shape fails toward "no answer"
// (a loud error upstream), never toward saving the wrong text.

interface TranscriptEntry {
  type?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  isCompactSummary?: unknown
  message?: { content?: unknown }
}

function parseEntries(jsonl: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry: unknown = JSON.parse(line)
      if (typeof entry === 'object' && entry !== null) entries.push(entry as TranscriptEntry)
    } catch {
      // A torn or foreign line must not fail the whole read.
    }
  }
  return entries
}

function contentBlocks(entry: TranscriptEntry): { type?: unknown; text?: unknown }[] {
  const content = entry.message?.content
  return Array.isArray(content) ? content : []
}

function isRealUserPrompt(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return false
  return !contentBlocks(entry).some((block) => block.type === 'tool_result')
}

function assistantText(entry: TranscriptEntry): string[] {
  if (entry.type !== 'assistant' || entry.isSidechain) return []
  return contentBlocks(entry).flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
}

// The newest real prompt is the /pipelinely-bookmark invocation itself, so
// the answer being saved is every assistant text block between the prompt
// before it and it, joined with a blank line.
export function lastAssistantAnswer(jsonl: string): string | null {
  const entries = parseEntries(jsonl)
  const promptIndexes = entries.flatMap((entry, index) => (isRealUserPrompt(entry) ? [index] : []))
  if (promptIndexes.length === 0) return null

  const invocationIndex = promptIndexes[promptIndexes.length - 1]
  const previousPromptIndex = promptIndexes.length > 1 ? promptIndexes[promptIndexes.length - 2] : -1
  const texts = entries.slice(previousPromptIndex + 1, invocationIndex).flatMap(assistantText)
  return texts.length > 0 ? texts.join('\n\n') : null
}

// A worker launches in the task dir and later cds into its worktree, so the
// project folder can't be derived from the cwd; look in every project folder.
export async function findTranscriptPath(projectsDir: string, sessionId: string): Promise<string | null> {
  if (!isSessionId(sessionId)) throw new Error(`'${sessionId}' is not a valid session id`)
  let projectFolders: string[]
  try {
    projectFolders = await fs.readdir(projectsDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  for (const folder of projectFolders) {
    const candidate = path.join(projectsDir, folder, `${sessionId}.jsonl`)
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Not in this project folder.
    }
  }
  return null
}
