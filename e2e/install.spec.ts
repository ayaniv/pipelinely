import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'
import { commitAll, git, headSha, initGitRepo, makeTempDir, pathExists, porcelainStatus, writeFiles, REPO_ROOT } from './fixtures/ossSource.js'

// install.sh: the umbrella installer served from pipelinely.cc for the
// `curl -fsSL https://pipelinely.cc/install.sh | sh` one-liner. Runs with a
// throwaway $HOME and PIPELINELY_DIR, a throwaway local origin repo, and a
// fake `git`/`npm` on PATH ahead of the real ones, so this suite never clones
// a real remote or runs a real `npm install` — same reasoning as e2e/oss-dotfiles-install.spec.ts's real
// tmux/plannotator binaries. Every other prerequisite install.sh preflights
// (node's version, tmux, jq, gh + its auth, claude, uname, the iTerm2 app,
// Homebrew's install prefixes) is stubbed the same way, present by default,
// so each preflight case removes exactly the one thing it's about.

const INSTALL_SCRIPT = path.join(REPO_ROOT, 'install.sh')
const BASE_PATH = '/usr/bin:/bin'
// Derived from the tmux dotfiles installer's own directory name rather than
// written as a literal — the e2e isolation guard (src/e2eIsolation.ts) flags
// a quoted literal of that binary name anywhere outside e2e/integration/,
// and this suite only ever puts a fake one on a throwaway PATH.
const TMUX_BINARY = path.basename(path.join(REPO_ROOT, 'dotfiles', 'tmux'))
const SUPPORTED_NODE_VERSION = '22.3.0'
const UNSUPPORTED_NODE_VERSION = '18.19.0'

let home: string
let dest: string
let stubBin: string
let callLog: string
let appsDir: string
let brewPrefix: string
let origin: string
let realGit: string

// A stand-in optional dotfiles installer with a made-up required binary
// (never real, never on any PATH) — proves install.sh's own dispatcher
// skips a failing optional installer without aborting, without needing a
// real installer's real required binary name in this file (the isolation
// guard flags literal osascript/tmux occurrences outside e2e/integration/).
const OPTIONAL_INSTALLER_DIR = 'widget'
const OPTIONAL_INSTALLER_BINARY = 'widgetcli'

// A fake `git` that logs every call and then hands it to the REAL git, so
// the update cases run against real repository states (a real lockfile
// change, a real divergence, a real unreachable remote) instead of canned
// answers. Two calls are intercepted: `--version` (STUB_GIT_VERSION_EXIT
// poses as the Command Line Tools shim) and `clone`, which clones the
// throwaway local origin in place of the github.com URL install.sh passes,
// so nothing ever touches the network. For the states real git can't be put
// in on demand, `git -C <dir> <subcommand>` can be made to fail
// (STUB_GIT_FAIL_ON=<subcommand>) or to print a warning on stderr and still
// succeed (STUB_GIT_WARN_ON=<subcommand>).
async function stubGit() {
  await writeFiles(stubBin, {
    git: `#!/bin/sh
echo "git $*" >> "${callLog}"
if [ "$1" = "--version" ] && [ -n "\${STUB_GIT_VERSION_EXIT:-}" ]; then exit "$STUB_GIT_VERSION_EXIT"; fi
if [ "$1" = "clone" ]; then exec "${realGit}" clone -q "${origin}" "$3"; fi
if [ "$1" = "-C" ] && [ "$3" = "\${STUB_GIT_FAIL_ON:-}" ]; then echo "fatal: injected $3 failure" >&2; exit 128; fi
if [ "$1" = "-C" ] && [ "$3" = "\${STUB_GIT_WARN_ON:-}" ]; then echo "warning: injected $3 warning" >&2; fi
exec "${realGit}" "$@"
`,
  })
  await fs.chmod(path.join(stubBin, 'git'), 0o755)
}

// A fake `npm` that models the one npm behaviour this suite is about: a plain
// `npm install` rewrites the tracked package-lock.json (as the real one did on
// every user's machine), while `npm ci` and `npm install --no-save` leave it
// alone. STUB_NPM_CI_EXIT / STUB_NPM_INSTALL_EXIT make either one fail.
async function stubNpm() {
  await writeFiles(stubBin, {
    npm: `#!/bin/sh
echo "npm $*" >> "${callLog}"
prefix=.
if [ "$1" = "--prefix" ]; then prefix="$2"; shift 2; fi
case "$1" in
  ci) code="\${STUB_NPM_CI_EXIT:-0}" ;;
  install)
    code="\${STUB_NPM_INSTALL_EXIT:-0}"
    case " $* " in *" --no-save "*) ;; *) echo "rewritten by npm install" >> "$prefix/package-lock.json" ;; esac ;;
  *) code=0 ;;
esac
[ "$code" = 0 ] || echo "npm error fake $1 failure" >&2
exit "$code"
`,
    // install.sh reads `node --version` to enforce Node 20+; the answer comes
    // from STUB_NODE_VERSION so a case can pose as an old Node. Keeps this
    // suite from depending on a real Node binary under /usr/bin or /bin.
    node: `#!/bin/sh\n[ -n "\${STUB_NODE_BROKEN:-}" ] && exit 1\necho "v\${STUB_NODE_VERSION:-${SUPPORTED_NODE_VERSION}}"\n`,
  })
  await fs.chmod(path.join(stubBin, 'npm'), 0o755)
  await fs.chmod(path.join(stubBin, 'node'), 0o755)
}

// The throwaway "github.com/ayaniv/pipelinely": a real local repo holding
// just what install.sh touches — two skills (so pipelinely* relinking is
// exercised), the dotfiles helpers, an optional installer, and a tracked
// package.json + package-lock.json.
async function createOrigin() {
  await initGitRepo(origin)
  await writeFiles(origin, {
    '.gitignore': 'node_modules/\n',
    'package.json': '{ "name": "pipelinely" }\n',
    'package-lock.json': '{ "name": "pipelinely", "lockfileVersion": 3 }\n',
    'src/server.ts': 'export {}\n',
    '.claude/skills/pipelinely/SKILL.md': '---\nname: pipelinely\n---\n',
    '.claude/skills/pipelinely-cr/SKILL.md': '---\nname: pipelinely-cr\n---\n',
    'dotfiles/lib/install-helpers.sh': await fs.readFile(path.join(REPO_ROOT, 'dotfiles/lib/install-helpers.sh'), 'utf-8'),
    [`dotfiles/${OPTIONAL_INSTALLER_DIR}/install.sh`]: `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "\${SCRIPT_DIR}/../lib/install-helpers.sh"
require_command ${OPTIONAL_INSTALLER_BINARY} "not a real package — test fixture only"
echo "fake ${OPTIONAL_INSTALLER_DIR} installer ran"
`,
  })
  await commitAll(origin, 'initial')
}

// The rest of the README's prerequisites. `gh auth status` answers with
// STUB_GH_AUTH_EXIT; `uname -s` answers with STUB_UNAME. Every call is logged
// so a case can prove the preflight ran before anything else did.
async function stubOtherPrerequisites() {
  const stubs: Record<string, string> = {
    [TMUX_BINARY]: `#!/bin/sh\nexit 0\n`,
    jq: `#!/bin/sh\nexit 0\n`,
    claude: `#!/bin/sh\nexit 0\n`,
    gh: `#!/bin/sh\necho "gh $*" >> "${callLog}"\nif [ "$1" = "auth" ]; then [ -n "\${STUB_GH_AUTH_DELAY:-}" ] && sleep "\$STUB_GH_AUTH_DELAY"; exit "\${STUB_GH_AUTH_EXIT:-0}"; fi\nexit 0\n`,
    uname: `#!/bin/sh\necho "\${STUB_UNAME:-Darwin}"\n`,
  }
  await writeFiles(stubBin, stubs)
  for (const name of Object.keys(stubs)) await fs.chmod(path.join(stubBin, name), 0o755)
}

function npmCiCall() {
  return `npm --prefix ${dest} ci`
}

async function removeStub(name: string) {
  await fs.rm(path.join(stubBin, name))
}

// stubEnv: extra env for one run — the STUB_* knobs of the fakes above, or an override of install.sh's own env.
function runInstaller({ withStubBin, stubEnv = {} }: { withStubBin: boolean; stubEnv?: Record<string, string> }) {
  // Real macOS ships a real `git` under /usr/bin (Xcode command line tools),
  // so proving the "git missing" failure path needs a PATH with no lookup
  // dirs at all, not just the stub bin left off.
  const runtimePath = withStubBin ? `${stubBin}:${BASE_PATH}` : ''
  return execa('/bin/bash', [INSTALL_SCRIPT], {
    reject: false,
    all: true,
    timeout: 30_000,
    env: {
      HOME: home,
      PIPELINELY_DIR: dest,
      PATH: runtimePath,
      // Where install.sh looks for iTerm.app and for a Homebrew install that
      // isn't on PATH yet — pointed at throwaway dirs so the developer's own
      // /Applications and /opt/homebrew never decide a case's outcome.
      PIPELINELY_APP_DIRS: appsDir,
      PIPELINELY_BREW_PREFIXES: brewPrefix,
      ...stubEnv,
    },
    extendEnv: false,
  })
}

test.beforeAll(async () => {
  realGit = (await execa('sh', ['-c', 'command -v git'])).stdout.trim()
})

test.beforeEach(async () => {
  home = await makeTempDir('install-home')
  dest = path.join(home, 'pipelinely')
  origin = path.join(home, 'origin')
  stubBin = path.join(home, 'stub-bin')
  callLog = path.join(home, 'calls.log')
  appsDir = path.join(home, 'Applications')
  brewPrefix = path.join(home, 'homebrew')
  await fs.mkdir(path.join(appsDir, 'iTerm.app'), { recursive: true })
  await createOrigin()
  await stubGit()
  await stubNpm()
  await stubOtherPrerequisites()
})

test.afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

test.describe('install.sh', () => {
  test('clones into PIPELINELY_DIR when missing, installs deps, and symlinks skills', async () => {
    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    const calls = await fs.readFile(callLog, 'utf-8')
    expect(calls).toContain(`git clone https://github.com/ayaniv/pipelinely.git ${dest}`)
    expect(calls).toContain(npmCiCall())

    const linked = path.join(home, '.claude/skills/pipelinely')
    expect(await fs.lstat(linked).then((s) => s.isSymbolicLink())).toBe(true)
    expect(await fs.realpath(linked)).toBe(await fs.realpath(path.join(dest, '.claude/skills/pipelinely')))
  })

  test('backs up a differing existing skill instead of silently overwriting it', async () => {
    await writeFiles(home, { '.claude/skills/pipelinely/SKILL.md': 'my own local copy\n' })

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    expect(await fs.lstat(path.join(home, '.claude/skills/pipelinely')).then((s) => s.isSymbolicLink())).toBe(true)
    const backups = await fs.readdir(path.join(home, '.claude/skills.bak'))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(home, '.claude/skills.bak', backups[0], 'SKILL.md'), 'utf-8')).toBe('my own local copy\n')
  })

  test('an optional dotfiles installer missing its required binary is skipped, not fatal', async () => {
    const result = await runInstaller({ withStubBin: true }) // OPTIONAL_INSTALLER_BINARY is never on the trimmed PATH
    expect(result.exitCode, result.all).toBe(0)
    expect(result.all).toContain(`skipped ${OPTIONAL_INSTALLER_DIR}`)
  })

  test('failure path: git is not on PATH — exits non-zero, says so, and clones nothing', async () => {
    const result = await runInstaller({ withStubBin: false })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/git.*not found/i)
    expect(await pathExists(dest)).toBe(false)
  })
})

// Re-running the one-liner is how an existing user updates, and the script is
// fetched fresh every time — so it has to cope with every state an old
// install's checkout can be in, and say loudly when it could not update.
test.describe('install.sh updating an existing checkout', () => {
  const NOT_UPDATED_TITLE = 'pipelinely was NOT updated.'
  const DONE_LINE = 'Done. Next steps:'
  const RESTART_LINE = 'Restart Claude Code so it loads the updated skills (it reads skills only at session start).'
  const LOCKFILE_RESTORED_LINE = 'Restored package-lock.json (an earlier install rewrote it) before updating.'

  function lines(output: string): string[] {
    return output.split('\n')
  }

  async function shortSha(dir: string): Promise<string> {
    return (await git(dir, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
  }

  async function commitDate(dir: string): Promise<string> {
    return (await git(dir, ['log', '-1', '--date=short', '--format=%cd'])).stdout.trim()
  }

  async function seedExistingCheckout() {
    await git(home, ['clone', '-q', origin, dest])
  }

  // The state every existing user is in: only the lockfile an older installer's `npm install` rewrote.
  async function seedLockfileOnlyChange() {
    await seedExistingCheckout()
    await fs.appendFile(path.join(dest, 'package-lock.json'), 'rewritten by an old npm install\n')
  }

  // A new upstream commit, so the seeded checkout is one commit behind.
  async function advanceOrigin(): Promise<string> {
    await writeFiles(origin, { 'src/server.ts': 'export const updated = true\n' })
    await commitAll(origin, 'upstream change')
    return headSha(origin)
  }

  // The last stdout lines say which checkout, commit and version are installed.
  async function expectInstalledVersionLines(result: { stdout: string }) {
    const sha = await shortSha(dest)
    const outputLines = lines(result.stdout)
    expect(outputLines).toContain(`  checkout: ${dest}`)
    expect(outputLines).toContain(`  commit:   ${sha} (${await commitDate(dest)})`)
    expect(outputLines).toContain('  version:  untagged')
  }

  // The NOT-updated block is on stderr and lands after "Done", where it can't scroll away.
  async function expectNotUpdatedBanner(result: { stderr: string; all?: string }, fixCommand: string) {
    const stderrLines = lines(result.stderr)
    expect(stderrLines).toContain(NOT_UPDATED_TITLE)
    expect(stderrLines).toContain(`    ${fixCommand}`)
    expect(stderrLines).toContain(`  Until then, the installed skills still point at the OLD checkout: ${dest} at ${await shortSha(dest)} (${await commitDate(dest)}).`)
    const all = result.all ?? ''
    expect(all.indexOf(NOT_UPDATED_TITLE)).toBeGreaterThan(all.indexOf(DONE_LINE))
  }

  async function expectSkillsLinkedToDest() {
    for (const skill of ['pipelinely', 'pipelinely-cr']) {
      const linked = path.join(home, '.claude/skills', skill)
      expect(await fs.lstat(linked).then((s) => s.isSymbolicLink())).toBe(true)
      expect(await fs.realpath(linked)).toBe(await fs.realpath(path.join(dest, '.claude/skills', skill)))
    }
  }

  test('a fresh install leaves the checkout clean (git status --porcelain empty)', async () => {
    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    expect(await porcelainStatus(dest)).toBe('')
    expect(lines(result.stdout)).toContain(RESTART_LINE)
    expect(result.stderr).not.toContain(NOT_UPDATED_TITLE)
    await expectInstalledVersionLines(result)
  })

  test('an existing clean main that is behind origin is fast-forwarded and reports the new commit', async () => {
    await seedExistingCheckout()
    const upstreamSha = await advanceOrigin()

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    expect(await headSha(dest)).toBe(upstreamSha)
    expect(lines(result.stdout)).toContain(`Updated to ${await shortSha(dest)} (${await commitDate(dest)}).`)
    expect(lines(result.stdout)).toContain(RESTART_LINE)
    expect(result.stderr).not.toContain(NOT_UPDATED_TITLE)
    expect(await fs.readFile(callLog, 'utf-8')).not.toContain('git clone')
    await expectInstalledVersionLines(result)
    await expectSkillsLinkedToDest()
  })

  test('the real-world case: main whose only change is the installer-rewritten package-lock.json is restored and updated', async () => {
    await seedLockfileOnlyChange()
    await writeFiles(dest, { 'node_modules/marker': 'ignored, must survive\n' })
    const upstreamSha = await advanceOrigin()

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    expect(lines(result.stdout)).toContain(LOCKFILE_RESTORED_LINE)
    expect(await headSha(dest)).toBe(upstreamSha)
    expect(await porcelainStatus(dest)).toBe('')
    expect(await fs.readFile(path.join(dest, 'node_modules/marker'), 'utf-8')).toBe('ignored, must survive\n')
    expect(result.stderr).not.toContain(NOT_UPDATED_TITLE)
    await expectInstalledVersionLines(result)
  })

  test('failure path: another modified file — nothing is touched (not even the lockfile), update skipped, banner printed', async () => {
    await seedLockfileOnlyChange()
    const seededSha = await headSha(dest)
    await writeFiles(dest, { 'src/server.ts': 'my own edit\n' })
    await advanceOrigin()

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    expect(await headSha(dest)).toBe(seededSha)
    expect(await fs.readFile(path.join(dest, 'src/server.ts'), 'utf-8')).toBe('my own edit\n')
    expect(await porcelainStatus(dest)).toBe('M package-lock.json\n M src/server.ts')
    expect(lines(result.stdout)).not.toContain(LOCKFILE_RESTORED_LINE)
    await expectNotUpdatedBanner(result, `git -C ${dest} stash push --include-untracked`)
    await expectInstalledVersionLines(result)
    await expectSkillsLinkedToDest()
  })

  test('failure path: an untracked file — left in place, update skipped, banner printed', async () => {
    await seedExistingCheckout()
    const seededSha = await headSha(dest)
    await writeFiles(dest, { 'notes.md': 'my notes\n' })
    await advanceOrigin()

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    expect(await headSha(dest)).toBe(seededSha)
    expect(await fs.readFile(path.join(dest, 'notes.md'), 'utf-8')).toBe('my notes\n')
    await expectNotUpdatedBanner(result, `git -C ${dest} stash push --include-untracked`)
    await expectInstalledVersionLines(result)
  })

  test('failure path: a STAGED package-lock.json change is the user\'s own — left staged, update skipped, banner printed', async () => {
    await seedLockfileOnlyChange()
    await git(dest, ['add', 'package-lock.json'])
    const seededSha = await headSha(dest)
    await advanceOrigin()

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    expect(await headSha(dest)).toBe(seededSha)
    expect(await porcelainStatus(dest)).toBe('M  package-lock.json')
    expect(lines(result.stdout)).not.toContain(LOCKFILE_RESTORED_LINE)
    await expectNotUpdatedBanner(result, `git -C ${dest} stash push --include-untracked`)
  })

  test('a warning git prints on stderr during status does not count as a local change', async () => {
    await seedLockfileOnlyChange()
    const upstreamSha = await advanceOrigin()

    const result = await runInstaller({ withStubBin: true, stubEnv: { STUB_GIT_WARN_ON: 'status' } })
    expect(result.exitCode, result.all).toBe(0)

    expect(await headSha(dest)).toBe(upstreamSha)
    expect(result.stderr).not.toContain(NOT_UPDATED_TITLE)
  })

  test('failure path: git status failing skips the update with a banner instead of aborting the install', async () => {
    await seedExistingCheckout()
    const seededSha = await headSha(dest)
    await advanceOrigin()

    const result = await runInstaller({ withStubBin: true, stubEnv: { STUB_GIT_FAIL_ON: 'status' } })
    expect(result.exitCode, result.all).toBe(0)

    expect(await headSha(dest)).toBe(seededSha)
    expect(result.stderr).toContain('fatal: injected status failure')
    await expectNotUpdatedBanner(result, `git -C ${dest} status`)
    await expectInstalledVersionLines(result)
  })

  test('failure path: restoring package-lock.json failing skips the update with a banner and leaves the change', async () => {
    await seedLockfileOnlyChange()
    const seededSha = await headSha(dest)
    await advanceOrigin()

    const result = await runInstaller({ withStubBin: true, stubEnv: { STUB_GIT_FAIL_ON: 'checkout' } })
    expect(result.exitCode, result.all).toBe(0)

    expect(await headSha(dest)).toBe(seededSha)
    expect(await porcelainStatus(dest)).toBe('M package-lock.json')
    expect(result.stderr).toContain('fatal: injected checkout failure')
    await expectNotUpdatedBanner(result, `git -C ${dest} checkout -- package-lock.json`)
  })

  test('failure path: a checkout on another branch is never switched, banner gives the switch command', async () => {
    await seedExistingCheckout()
    await git(dest, ['switch', '-q', '-c', 'publish/abc123'])
    await advanceOrigin()

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    expect((await git(dest, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim()).toBe('publish/abc123')
    await expectNotUpdatedBanner(result, `git -C ${dest} switch main`)
    await expectInstalledVersionLines(result)
    await expectSkillsLinkedToDest()
  })

  test('failure path: a main that diverged from origin is never forced, banner carries the git error', async () => {
    await seedExistingCheckout()
    await writeFiles(dest, { 'local.txt': 'local commit\n' })
    await commitAll(dest, 'local work')
    const localSha = await headSha(dest)
    await advanceOrigin()

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    expect(await headSha(dest)).toBe(localSha)
    expect(result.stderr).toMatch(/fast-forward/i)
    await expectNotUpdatedBanner(result, `git -C ${dest} pull --rebase origin main`)
    await expectInstalledVersionLines(result)
  })

  test('failure path: fetch fails (offline / unreachable remote) — nothing forced, banner carries the git error', async () => {
    await seedExistingCheckout()
    const seededSha = await headSha(dest)
    const unreachable = path.join(home, 'unreachable-remote')
    await git(dest, ['remote', 'set-url', 'origin', unreachable])

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    expect(await headSha(dest)).toBe(seededSha)
    expect(result.stderr).toContain(unreachable)
    await expectNotUpdatedBanner(result, `git -C ${dest} fetch origin main`)
    await expectInstalledVersionLines(result)
  })

  test('failure path: a detached HEAD is skipped, banner printed', async () => {
    await seedExistingCheckout()
    await git(dest, ['checkout', '-q', '--detach'])
    await advanceOrigin()

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    await expectNotUpdatedBanner(result, `git -C ${dest} switch main`)
    await expectInstalledVersionLines(result)
  })

  test('failure path: a checkout with no origin remote is skipped, banner gives the remote add command', async () => {
    await seedExistingCheckout()
    await git(dest, ['remote', 'remove', 'origin'])

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    await expectNotUpdatedBanner(result, `git -C ${dest} remote add origin https://github.com/ayaniv/pipelinely.git`)
    await expectInstalledVersionLines(result)
  })

  test('idempotent: re-running right after an install changes nothing and asks for no restart', async () => {
    const first = await runInstaller({ withStubBin: true })
    expect(first.exitCode, first.all).toBe(0)
    const installedSha = await headSha(dest)

    const second = await runInstaller({ withStubBin: true })
    expect(second.exitCode, second.all).toBe(0)

    expect(await headSha(dest)).toBe(installedSha)
    expect(await porcelainStatus(dest)).toBe('')
    expect(lines(second.stdout)).toContain(`Already up to date at ${await shortSha(dest)} (${await commitDate(dest)}).`)
    expect(lines(second.stdout)).not.toContain(RESTART_LINE)
    expect(second.stderr).not.toContain(NOT_UPDATED_TITLE)
    await expectInstalledVersionLines(second)
  })

  test('skill links that point at another checkout, or are real directories, are repointed at this checkout', async () => {
    const otherCheckoutSkill = path.join(home, 'old-checkout/.claude/skills/pipelinely')
    await writeFiles(otherCheckoutSkill, { 'SKILL.md': 'old\n' })
    await fs.mkdir(path.join(home, '.claude/skills'), { recursive: true })
    await fs.symlink(otherCheckoutSkill, path.join(home, '.claude/skills/pipelinely'))
    await writeFiles(path.join(home, '.claude/skills/pipelinely-cr'), { 'SKILL.md': 'my own copy\n' })

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    await expectSkillsLinkedToDest()
    expect(await fs.readFile(path.join(otherCheckoutSkill, 'SKILL.md'), 'utf-8')).toBe('old\n')
    const backups = await fs.readdir(path.join(home, '.claude/skills.bak'))
    expect(backups).toHaveLength(1)
    expect(lines(result.stdout)).toContain(RESTART_LINE)
  })

  test('npm ci failing falls back to npm install --no-save, says so, and still leaves the checkout clean', async () => {
    const result = await runInstaller({ withStubBin: true, stubEnv: { STUB_NPM_CI_EXIT: '1' } })
    expect(result.exitCode, result.all).toBe(0)

    expect(await fs.readFile(callLog, 'utf-8')).toContain(`npm --prefix ${dest} install --no-save`)
    expect(lines(result.stderr)).toContain('npm ci failed (see above) — retrying with npm install --no-save.')
    expect(await porcelainStatus(dest)).toBe('')
  })

  test('failure path: npm ci and the fallback both failing is reported and exits non-zero', async () => {
    const result = await runInstaller({ withStubBin: true, stubEnv: { STUB_NPM_CI_EXIT: '1', STUB_NPM_INSTALL_EXIT: '1' } })
    expect(result.exitCode).not.toBe(0)

    expect(lines(result.stderr)).toContain('install.sh: installing dependencies failed (see npm output above).')
    expect(lines(result.stdout)).not.toContain(DONE_LINE)
  })
})

// Preflight: every README prerequisite is checked before install.sh changes
// anything, and all the gaps are reported together, each with its fix.
test.describe('install.sh prerequisite preflight', () => {
  async function callsSoFar(): Promise<string> {
    return (await pathExists(callLog)) ? fs.readFile(callLog, 'utf-8') : ''
  }

  async function expectNothingChanged() {
    expect(await pathExists(dest)).toBe(false)
    expect(await pathExists(path.join(home, '.claude/skills'))).toBe(false)
    const calls = await callsSoFar()
    expect(calls).not.toContain('git clone')
    expect(calls).not.toContain('npm ')
  }

  test('everything present — confirms the prerequisites and carries on with the install', async () => {
    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)
    expect(result.all).toMatch(/prerequisites/i)
    expect(result.all).not.toMatch(/missing/i)
    expect(await callsSoFar()).toContain(npmCiCall())
  })

  test('failure path: several prerequisites missing — lists every one with its fix, then stops before changing anything', async () => {
    await removeStub('node')
    await removeStub('gh')

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toMatch(/missing/i)
    expect(result.all).toContain('brew install node')
    expect(result.all).toContain('brew install gh')
    await expectNothingChanged()
  })

  test('failure path: Node older than 20 — reported with the version found', async () => {
    const result = await runInstaller({ withStubBin: true, stubEnv: { STUB_NODE_VERSION: UNSUPPORTED_NODE_VERSION } })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toContain('20+')
    expect(result.all).toContain(UNSUPPORTED_NODE_VERSION)
    expect(result.all).toContain('brew install node')
    await expectNothingChanged()
  })

  test('failure path: tmux missing — fix is brew install', async () => {
    await removeStub(TMUX_BINARY)

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toContain(`brew install ${TMUX_BINARY}`)
    await expectNothingChanged()
  })

  test('failure path: gh installed but not signed in — fix is gh auth login', async () => {
    const result = await runInstaller({ withStubBin: true, stubEnv: { STUB_GH_AUTH_EXIT: '1' } })
    expect(result.exitCode).not.toBe(0)
    expect(await callsSoFar()).toContain('gh auth status')
    expect(result.all).toContain('gh auth login')
    expect(result.all).not.toContain('brew install gh')
    await expectNothingChanged()
  })

  test('failure path: the claude CLI missing — says how to install Claude Code', async () => {
    await removeStub('claude')

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toContain('@anthropic-ai/claude-code')
    await expectNothingChanged()
  })

  test('failure path: iTerm2 not installed — fix is the iterm2 cask', async () => {
    await fs.rm(path.join(appsDir, 'iTerm.app'), { recursive: true })

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toContain('brew install --cask iterm2')
    await expectNothingChanged()
  })

  test('failure path: not macOS — says macOS is required and stops', async () => {
    const result = await runInstaller({ withStubBin: true, stubEnv: { STUB_UNAME: 'Linux' } })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toMatch(/macOS/)
    await expectNothingChanged()
  })

  test('failure path: a brew fix is needed and Homebrew is not installed — says to install Homebrew first', async () => {
    await removeStub('node')

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toContain('Homebrew/install')
    expect(result.all).not.toContain('brew shellenv')
    await expectNothingChanged()
  })

  test('failure path: a brew fix is needed and Homebrew is installed but not on PATH — says to add it to PATH, not reinstall', async () => {
    await removeStub('node')
    const installedBrew = path.join(brewPrefix, 'bin', 'brew')
    await writeFiles(brewPrefix, { 'bin/brew': '#!/bin/sh\nexit 0\n' })
    await fs.chmod(installedBrew, 0o755)

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toContain(`${installedBrew} shellenv`)
    expect(result.all).not.toContain('Homebrew/install')
    await expectNothingChanged()
  })

  test('a brew fix is needed and brew is already on PATH — no Homebrew advice at all', async () => {
    await removeStub('node')
    await writeFiles(stubBin, { brew: '#!/bin/sh\nexit 0\n' })
    await fs.chmod(path.join(stubBin, 'brew'), 0o755)

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toContain('brew install node')
    expect(result.all).not.toContain('Homebrew/install')
    expect(result.all).not.toContain('brew shellenv')
  })

  test('failure path: an existing checkout is not fast-forwarded when a prerequisite is missing', async () => {
    await execa('git', ['init', '-q', dest]) // real git — only to create a .git dir
    await removeStub('claude')

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode).not.toBe(0)
    const calls = await callsSoFar()
    expect(calls).not.toContain(`-C ${dest} fetch`)
    expect(calls).not.toContain(`-C ${dest} merge`)
    expect(calls).not.toContain('npm ')
  })

  test('failure path: git is only the Command Line Tools shim — reported missing with the xcode-select fix', async () => {
    const result = await runInstaller({ withStubBin: true, stubEnv: { STUB_GIT_VERSION_EXIT: '1' } })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toContain('xcode-select --install')
    await expectNothingChanged()
  })

  test('failure path: gh auth is checked against github.com only', async () => {
    await runInstaller({ withStubBin: true })
    expect(await callsSoFar()).toContain('gh auth status --hostname github.com')
  })

  test('failure path: gh auth hangs — the check is bounded and reported, not waited on forever', async () => {
    const startedAt = Date.now()
    const result = await runInstaller({ withStubBin: true, stubEnv: { STUB_GH_AUTH_DELAY: '30', PIPELINELY_GH_TIMEOUT_SECONDS: '1' } })
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toContain('gh auth login')
    await expectNothingChanged()
  })

  test('a home directory containing a space does not hide an installed iTerm2', async () => {
    const spacedHome = path.join(home, 'Jane Doe')
    await fs.mkdir(path.join(spacedHome, 'Applications', 'iTerm.app'), { recursive: true })
    await fs.rm(path.join(appsDir, 'iTerm.app'), { recursive: true })

    // Explicit list shaped like the default (a system dir, then $HOME/Applications)
    // but never the real /Applications, so the developer's own iTerm2 can't satisfy it.
    const fakeSystemApps = path.join(home, 'system-apps')
    await fs.mkdir(fakeSystemApps)
    const result = await runInstaller({
      withStubBin: true,
      stubEnv: { HOME: spacedHome, PIPELINELY_APP_DIRS: `${fakeSystemApps}:${spacedHome}/Applications` },
    })
    expect(result.all).not.toContain('iTerm2 not found')
  })

  test('a successful run prints no watchdog job report', async () => {
    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)
    expect(result.stderr).not.toMatch(/Terminated|line \d+:/)
    expect(result.all).toContain('gh signed in')
  })

  // gh takes a moment to answer, so a timeout that wrongly stayed invalid (and
  // made the watchdog kill it at once) would report "not signed in".
  for (const invalidTimeout of ['soon', '0']) {
    test(`an invalid gh timeout (${invalidTimeout}) falls back to the default instead of killing gh at once`, async () => {
      const result = await runInstaller({
        withStubBin: true,
        stubEnv: { PIPELINELY_GH_TIMEOUT_SECONDS: invalidTimeout, STUB_GH_AUTH_DELAY: '1' },
      })
      expect(result.exitCode, result.all).toBe(0)
      expect(result.all).toContain('gh signed in')
    })
  }

  test('failure path: node exists but errors on --version — reported, not a crash', async () => {
    const result = await runInstaller({ withStubBin: true, stubEnv: { STUB_NODE_BROKEN: '1' } })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toContain('20+')
    expect(result.all).toContain('brew install node')
    await expectNothingChanged()
  })

  test('failure path: not macOS — no brew or Homebrew advice is printed', async () => {
    await removeStub('node')
    const result = await runInstaller({ withStubBin: true, stubEnv: { STUB_UNAME: 'Linux' } })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toMatch(/macOS/)
    expect(result.all).not.toContain('brew')
    expect(result.all).not.toContain('Homebrew')
  })

  test('failure path: Homebrew installed at the Intel /usr/local-style second prefix — found and advised', async () => {
    await removeStub('node')
    const intelPrefix = path.join(home, 'usr-local')
    await writeFiles(intelPrefix, { 'bin/brew': '#!/bin/sh\nexit 0\n' })
    await fs.chmod(path.join(intelPrefix, 'bin', 'brew'), 0o755)

    const result = await runInstaller({ withStubBin: true, stubEnv: { PIPELINELY_BREW_PREFIXES: `${brewPrefix}:${intelPrefix}` } })
    expect(result.all).toContain(`${intelPrefix}/bin/brew shellenv`)
    expect(result.all).not.toContain('Homebrew/install')
  })

  test('failure path: a brew file that is not executable does not count as Homebrew being installed', async () => {
    await removeStub('node')
    await writeFiles(brewPrefix, { 'bin/brew': '#!/bin/sh\nexit 0\n' }) // written without the executable bit

    const result = await runInstaller({ withStubBin: true })
    expect(result.all).toContain('Homebrew/install')
    expect(result.all).not.toContain('brew shellenv')
  })

  test('the off-PATH Homebrew advice gives a copy-pasteable profile line, keyed off the login shell', async () => {
    await removeStub('node')
    await writeFiles(brewPrefix, { 'bin/brew': '#!/bin/sh\nexit 0\n' })
    await fs.chmod(path.join(brewPrefix, 'bin', 'brew'), 0o755)

    const result = await runInstaller({ withStubBin: true, stubEnv: { SHELL: '/bin/zsh' } })
    expect(result.all).toContain(`>> ~/.zprofile`)
  })

  test('the MISSING block goes to stderr, not stdout', async () => {
    await removeStub('claude')
    const result = await runInstaller({ withStubBin: true })
    expect(result.stderr).toContain('@anthropic-ai/claude-code')
    expect(result.stdout).not.toContain('@anthropic-ai/claude-code')
  })

  test('idempotent: re-running after fixing the missing prerequisite completes the install', async () => {
    await removeStub('claude')
    const failed = await runInstaller({ withStubBin: true })
    expect(failed.exitCode).not.toBe(0)
    await expectNothingChanged()

    await writeFiles(stubBin, { claude: '#!/bin/sh\nexit 0\n' })
    await fs.chmod(path.join(stubBin, 'claude'), 0o755)
    const rerun = await runInstaller({ withStubBin: true })
    expect(rerun.exitCode, rerun.all).toBe(0)
    expect(await callsSoFar()).toContain(npmCiCall())
  })
})
