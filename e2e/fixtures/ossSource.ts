import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Shared by the oss-* specs (see tasks/pipelinely-oss-extraction/tech-design.md):
// they all build a throwaway private-repo tree or a throwaway $HOME, run one
// of the oss/ or dotfiles/ shell scripts against it, and inspect the result —
// never the real ~/Dev/pipelinely checkout or the real ~/.claude.
export const REPO_ROOT = path.join(__dirname, '..', '..')
export const ALLOWLIST_PATH = path.join(REPO_ROOT, 'oss', 'allowlist.txt')

export interface Allowlist {
  include: string[]
  exclude: string[]
}

// oss/allowlist.txt: one repo-relative path per line (directories end in
// "/"), "#" comments, and "!<git pathspec glob>" lines for tracked files
// under an included path that must still never ship.
export async function readAllowlist(): Promise<Allowlist> {
  const raw = await fs.readFile(ALLOWLIST_PATH, 'utf-8')
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  return {
    include: lines.filter((line) => !line.startsWith('!')),
    exclude: lines.filter((line) => line.startsWith('!')).map((line) => line.slice(1)),
  }
}

export async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
}

export async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false)
}

export function git(cwd: string, args: string[]) {
  return execa('git', ['-c', 'user.name=OSS Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd })
}

export async function initGitRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await git(dir, ['init', '-q', '-b', 'main'])
}

export async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', message])
}

export async function headSha(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
}

export async function porcelainStatus(dir: string): Promise<string> {
  return (await git(dir, ['status', '--porcelain'])).stdout.trim()
}

// A minimal stand-in for the private cockpit-ai repo: the real oss/ tooling
// copied in, every allow-listed path stubbed with one placeholder file, plus
// whatever extra files a case needs, all committed (the tooling only ever
// looks at tracked files).
export async function createFakeOssSource(root: string, extraFiles: Record<string, string> = {}): Promise<void> {
  await fs.cp(path.join(REPO_ROOT, 'oss'), path.join(root, 'oss'), { recursive: true })
  const { include } = await readAllowlist()
  const stubs = Object.fromEntries(
    include.map((entry) => [entry.endsWith('/') ? `${entry}placeholder.txt` : entry, 'placeholder\n'])
  )
  await writeFiles(root, { ...stubs, ...extraFiles })
  await initGitRepo(root)
  await commitAll(root, 'fake private source')
}

// A stand-in for the public pipelinely repo as the developer actually has it:
// a bare repo playing GitHub (one commit on main, seeded with <files>) plus a
// local clone of it with `origin` pointing there. publish.sh branches off
// origin/main, so a checkout with no origin no longer models reality.
export async function createFakePublicCheckout(
  work: string,
  files: Record<string, string> = {}
): Promise<{ remote: string; checkout: string }> {
  const seed = path.join(work, 'pipelinely-seed')
  await initGitRepo(seed)
  await writeFiles(seed, files)
  await commitAll(seed, 'public repo initial commit')
  const remote = path.join(work, 'pipelinely.git')
  await execa('git', ['clone', '-q', '--bare', seed, remote])
  await fs.rm(seed, { recursive: true, force: true })
  const checkout = path.join(work, 'pipelinely')
  await execa('git', ['clone', '-q', remote, checkout])
  return { remote, checkout }
}

export function runScript(scriptPath: string, args: string[] = [], env: Record<string, string> = {}) {
  return execa('bash', [scriptPath, ...args], {
    reject: false,
    timeout: 90_000,
    env: { ...process.env, ...env },
  })
}
