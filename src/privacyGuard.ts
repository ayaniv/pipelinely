import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const URL_ALLOWLIST_RELATIVE_PATH = 'oss/url-allowlist.txt'

export interface UrlAllowlist {
  hosts: string[]
  files: string[]
}

export interface ShippedFile {
  path: string
  content: string
}

export interface UrlViolation {
  file: string
  line: number
  host: string
  url: string
}

// Host is captured separately so the allowlist compares hostnames, not URL
// text. Characters like ${ and [ are excluded on purpose: a templated or
// IPv6-literal "host" is not a statically known destination.
const ABSOLUTE_URL_PATTERN = /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)[^\s"'`)<>\]]*/gi

// Strips the "# reason" comment; an entry without one is rejected so the
// allowlist can't silently grow unexplained exceptions.
const ENTRY_PATTERN = /^(\S+)\s+(\S+)\s+#\s*\S/

export function parseUrlAllowlist(text: string): UrlAllowlist {
  const allowlist: UrlAllowlist = { hosts: [], files: [] }
  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) return
    const lineNumber = index + 1
    const entry = ENTRY_PATTERN.exec(line)
    if (!entry) throw new Error(`${URL_ALLOWLIST_RELATIVE_PATH}:${lineNumber}: entry needs "<kind> <value> # reason"`)
    const [, kind, value] = entry
    if (kind === 'host') allowlist.hosts.push(value.toLowerCase())
    else if (kind === 'file') allowlist.files.push(value)
    else throw new Error(`${URL_ALLOWLIST_RELATIVE_PATH}:${lineNumber}: unknown kind "${kind}" (expected host or file)`)
  })
  return allowlist
}

// A host entry also covers its subdomains. A dotless host (http://x, an
// intranet name) can't be a public destination, so it never counts.
function isAllowedHost(host: string, allowlist: UrlAllowlist): boolean {
  if (!host.includes('.')) return true
  return allowlist.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

export function findOutboundUrlViolations(files: ShippedFile[], allowlist: UrlAllowlist): UrlViolation[] {
  const violations: UrlViolation[] = []
  for (const file of files) {
    if (allowlist.files.includes(file.path)) continue
    file.content.split('\n').forEach((lineText, index) => {
      for (const match of lineText.matchAll(ABSOLUTE_URL_PATTERN)) {
        const host = match[1].toLowerCase()
        if (!isAllowedHost(host, allowlist)) {
          violations.push({ file: file.path, line: index + 1, host, url: match[0] })
        }
      }
    })
  }
  return violations
}

// Reuses oss/lib.sh's reader so "what ships" is defined only by
// oss/allowlist.txt; this module never parses that file itself.
export function listShippedFiles(root: string): string[] {
  try {
    const output = execFileSync(
      'bash',
      ['-c', 'source "$1/oss/lib.sh" && oss_list_shipped_files "$1"', '_', root],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    )
    return output.split('\0').filter((shippedPath) => shippedPath !== '')
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    throw new Error(`could not list shipped files under ${root} via oss/lib.sh: ${stderr || (error as Error).message}`)
  }
}

function isBinary(buffer: Buffer): boolean {
  return buffer.includes(0)
}

export function scanShippedTree(root: string): UrlViolation[] {
  const allowlist = parseUrlAllowlist(fs.readFileSync(path.join(root, URL_ALLOWLIST_RELATIVE_PATH), 'utf8'))
  const files: ShippedFile[] = []
  for (const relativePath of listShippedFiles(root)) {
    const buffer = fs.readFileSync(path.join(root, relativePath))
    if (!isBinary(buffer)) files.push({ path: relativePath, content: buffer.toString('utf8') })
  }
  return findOutboundUrlViolations(files, allowlist)
}
