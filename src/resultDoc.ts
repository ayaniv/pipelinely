import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import type { ResultDoc, ResultDocMeta } from './types.js'

// A research task's deliverable (audit, design, findings), found by
// convention so a worker needs no dashboard-specific wiring. First match wins;
// RESULT.md is what the skills tell new workers to write, the rest keep
// already-finished investigate tasks working without a rename.
export const RESULT_DOC_FILES = ['RESULT.md', 'AUDIT.md', 'DESIGN.md', 'FINDINGS.md'] as const

// A deliverable is cut here, and the field says so, rather than truncating
// silently. Also bounds what is ever read from disk, however big the file is.
export const MAX_RESULT_DOC_BYTES = 512 * 1024

// Room for the (up to 3) bytes of a multi-byte character the cap may split.
const CHARACTER_SLACK_BYTES = 4

const TASK_MD_FILE = 'TASK.md'
const RESULT_HEADING_RE = /^##[ \t]+Result[ \t]*$/i
const H2_HEADING_RE = /^##[ \t]+\S/
const FENCE_RE = /^\s*(```|~~~)/

// Dev workers of an implement task write a "## Result" of PR notes into TASK.md
// too; that is a hand-off note, not a deliverable, so only a research task's
// section counts.
const RESEARCH_MODES: readonly string[] = ['investigate', 'verify']

// The body of TASK.md's "## Result" section, up to the next "## " heading.
// Headings inside a fenced code block are examples, not structure.
function extractResultSection(taskMd: string): string | null {
  const body: string[] = []
  let isInsideFence = false
  let isInsideSection = false
  for (const line of taskMd.split('\n')) {
    if (FENCE_RE.test(line)) isInsideFence = !isInsideFence
    if (!isInsideFence && !FENCE_RE.test(line)) {
      if (isInsideSection && H2_HEADING_RE.test(line)) break
      if (!isInsideSection && RESULT_HEADING_RE.test(line)) {
        isInsideSection = true
        continue
      }
    }
    if (isInsideSection) body.push(line)
  }
  return isInsideSection ? body.join('\n').trim() : null
}

// `bytes` is at most cap + slack of the file's start; `totalBytes` is its full
// size, which is how a cut document reports how much was left out.
function toResultDoc(file: string, bytes: Buffer, totalBytes: number, mtimeMs: number): ResultDoc | null {
  const isTruncated = totalBytes > MAX_RESULT_DOC_BYTES
  // Decoding a slice can end in half a character; drop it so the cut never
  // renders as a replacement glyph.
  const markdown = bytes.subarray(0, MAX_RESULT_DOC_BYTES).toString('utf-8').replace(/�$/, '')
  if (!markdown.trim()) return null
  return { file, markdown, isTruncated, totalBytes, mtimeMs }
}

function isInside(realDir: string, realFile: string): boolean {
  return realFile.startsWith(realDir + path.sep)
}

interface ReadResult {
  bytes: Buffer
  totalBytes: number
  mtimeMs: number
}

interface CachedRead extends ReadResult {
  size: number
}

// Keyed by absolute path, so a repeat call for the same candidate across
// refreshes (every parseTask, plus the /result-doc endpoint on top) can skip
// the read entirely when the file is unchanged — the lstat that decides that
// is already required for the symlink/containment checks below, so this adds
// no extra I/O to the common case. Never pruned: the tasks dir is small and
// long-lived, so this stays bounded by the number of task dirs ever seen by
// this process.
const readCache = new Map<string, CachedRead>()

// The file's first cap bytes and its size, or null when it is absent or not
// something to broadcast: a symlink or any non-regular file, or a path that
// resolves outside the task dir. Everything but "absent" is logged, since it is
// a file the worker meant as the deliverable and someone should know it was
// refused.
async function readCandidate(dir: string, file: string): Promise<ReadResult | null> {
  const fullPath = path.join(dir, file)
  try {
    const info = await fs.lstat(fullPath)
    if (!info.isFile()) {
      readCache.delete(fullPath)
      console.error(`[resultDoc] ${file} in ${dir} is not a regular file; skipped`, { isSymbolicLink: info.isSymbolicLink() })
      return null
    }
    const [realDir, realFile] = await Promise.all([fs.realpath(dir), fs.realpath(fullPath)])
    if (!isInside(realDir, realFile)) {
      readCache.delete(fullPath)
      console.error(`[resultDoc] ${file} in ${dir} resolves outside the task dir; skipped`, realFile)
      return null
    }

    const cached = readCache.get(fullPath)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return { bytes: cached.bytes, totalBytes: cached.totalBytes, mtimeMs: cached.mtimeMs }
    }

    // O_NOFOLLOW closes the gap between the lstat above and this open: a file
    // swapped for a symlink in between fails to open instead of being
    // followed. O_NONBLOCK covers the narrower race of a file swapped for a
    // FIFO: without it, opening one for read with no writer on the other end
    // blocks forever; the isFile() re-check below covers the swap itself.
    const handle = await fs.open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    try {
      const reStat = await handle.stat()
      if (!reStat.isFile()) {
        readCache.delete(fullPath)
        console.error(`[resultDoc] ${file} in ${dir} changed to a non-regular file between lstat and open; skipped`, { isFile: false })
        return null
      }
      const wanted = Math.min(reStat.size, MAX_RESULT_DOC_BYTES + CHARACTER_SLACK_BYTES)
      const bytes = Buffer.alloc(wanted)
      const { bytesRead } = await handle.read(bytes, 0, wanted, 0)
      const result: ReadResult = { bytes: bytes.subarray(0, bytesRead), totalBytes: reStat.size, mtimeMs: reStat.mtimeMs }
      readCache.set(fullPath, { ...result, size: reStat.size })
      return result
    } finally {
      await handle.close()
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.error(`[resultDoc] could not read ${file} in ${dir}:`, err)
    return null
  }
}

// null when the task has no deliverable, or when none of the candidates could
// be read — an unreadable file is logged and skipped, never thrown, so one bad
// file cannot take the whole task's parse down. `mode` is the task's own Mode:
// it decides whether TASK.md's "## Result" section may stand in for a file.
export async function findResultDoc(dir: string, taskMdContent: string | null, mode: string): Promise<ResultDoc | null> {
  for (const file of RESULT_DOC_FILES) {
    const candidate = await readCandidate(dir, file)
    const doc = candidate && toResultDoc(file, candidate.bytes, candidate.totalBytes, candidate.mtimeMs)
    if (doc) return doc
  }
  const section = taskMdContent && RESEARCH_MODES.includes(mode) ? extractResultSection(taskMdContent) : null
  if (!section) return null
  const bytes = Buffer.from(section, 'utf-8')
  // TASK.md's own mtime, since the section has no file of its own — a
  // TASK.md rewrite (its only source) always changes this.
  const taskMdStat = await fs.stat(path.join(dir, TASK_MD_FILE)).catch(() => null)
  return toResultDoc(TASK_MD_FILE, bytes, bytes.length, taskMdStat?.mtimeMs ?? Date.now())
}

// What rides every task snapshot: enough to show the tab and note a cut, with
// the markdown itself fetched lazily (GET /result-doc/:slug) when it is opened.
export function toResultDocMeta(doc: ResultDoc | null): ResultDocMeta | null {
  return doc && { file: doc.file, isTruncated: doc.isTruncated, totalBytes: doc.totalBytes, mtimeMs: doc.mtimeMs }
}
