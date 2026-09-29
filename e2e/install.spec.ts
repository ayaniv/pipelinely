import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'
import { makeTempDir, pathExists, writeFiles, REPO_ROOT } from './fixtures/ossSource.js'

// install.sh: the umbrella installer served from pipelinely.cc for the
// `curl -fsSL https://pipelinely.cc/install.sh | sh` one-liner. Runs with a
// throwaway $HOME and PIPELINELY_DIR, and a fake `git`/`npm` on PATH ahead of
// the real ones, so this suite never clones a real repo or runs a real
// `npm install` — same reasoning as e2e/oss-dotfiles-install.spec.ts's real
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

// A stand-in optional dotfiles installer with a made-up required binary
// (never real, never on any PATH) — proves install.sh's own dispatcher
// skips a failing optional installer without aborting, without needing a
// real installer's real required binary name in this file (the isolation
// guard flags literal osascript/tmux occurrences outside e2e/integration/).
const OPTIONAL_INSTALLER_DIR = 'widget'
const OPTIONAL_INSTALLER_BINARY = 'widgetcli'

// A fake `git` that only understands `clone <remote> <dir>` (creates a
// minimal checkout: dotfiles/, .claude/skills/, so the rest of install.sh has
// something real to symlink/source) and the `-C <dir>` subcommands install.sh
// uses on an existing checkout: `rev-parse --git-dir` (is DEST a git repo),
// `symbolic-ref` / `status --porcelain` / `pull` (can it be fast-forwarded).
// Their answers come from STUB_GIT_* env vars so each test picks its scenario.
async function stubGit() {
  await writeFiles(stubBin, {
    git: `#!/bin/sh
echo "git $*" >> "${callLog}"
if [ "$1" = "--version" ]; then exit "\${STUB_GIT_VERSION_EXIT:-0}"; fi
if [ "$1" = "clone" ]; then
  mkdir -p "$3/.claude/skills/pipelinely" "$3/dotfiles/lib" "$3/dotfiles/${OPTIONAL_INSTALLER_DIR}"
  echo "fake skill" > "$3/.claude/skills/pipelinely/SKILL.md"
  cp "${path.join(REPO_ROOT, 'dotfiles/lib/install-helpers.sh')}" "$3/dotfiles/lib/install-helpers.sh"
  cat > "$3/dotfiles/${OPTIONAL_INSTALLER_DIR}/install.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "\${SCRIPT_DIR}/../lib/install-helpers.sh"
require_command ${OPTIONAL_INSTALLER_BINARY} "not a real package — test fixture only"
echo "fake ${OPTIONAL_INSTALLER_DIR} installer ran"
INNER
  chmod +x "$3/dotfiles/${OPTIONAL_INSTALLER_DIR}/install.sh"
  exit 0
fi
if [ "$1" = "-C" ]; then
  case "$3" in
    rev-parse) [ -d "$2/.git" ] && exit 0 || exit 1 ;;
    symbolic-ref) echo "\${STUB_GIT_BRANCH:-main}"; exit 0 ;;
    status) echo "\${STUB_GIT_STATUS:-}"; exit 0 ;;
    pull) exit "\${STUB_GIT_PULL_EXIT:-0}" ;;
  esac
fi
echo "fake git: unsupported command: $*" >&2
exit 1
`,
  })
  await fs.chmod(path.join(stubBin, 'git'), 0o755)
}

async function stubNpm() {
  await writeFiles(stubBin, {
    npm: `#!/bin/sh\necho "npm $*" >> "${callLog}"\nexit 0\n`,
    // install.sh reads `node --version` to enforce Node 20+; the answer comes
    // from STUB_NODE_VERSION so a case can pose as an old Node. Keeps this
    // suite from depending on a real Node binary under /usr/bin or /bin.
    node: `#!/bin/sh\n[ -n "\${STUB_NODE_BROKEN:-}" ] && exit 1\necho "v\${STUB_NODE_VERSION:-${SUPPORTED_NODE_VERSION}}"\n`,
  })
  await fs.chmod(path.join(stubBin, 'npm'), 0o755)
  await fs.chmod(path.join(stubBin, 'node'), 0o755)
}

// The rest of the README's prerequisites. `gh auth status` answers with
// STUB_GH_AUTH_EXIT; `uname -s` answers with STUB_UNAME. Every call is logged
// so a case can prove the preflight ran before anything else did.
async function stubOtherPrerequisites() {
  const stubs: Record<string, string> = {
    [TMUX_BINARY]: `#!/bin/sh\nexit 0\n`,
    jq: `#!/bin/sh\nexit 0\n`,
    claude: `#!/bin/sh\nexit 0\n`,
    gh: `#!/bin/sh\necho "gh $*" >> "${callLog}"\nif [ "$1" = "auth" ]; then [ -n "\${STUB_GH_AUTH_HANG:-}" ] && sleep 30; exit "\${STUB_GH_AUTH_EXIT:-0}"; fi\nexit 0\n`,
    uname: `#!/bin/sh\necho "\${STUB_UNAME:-Darwin}"\n`,
  }
  await writeFiles(stubBin, stubs)
  for (const name of Object.keys(stubs)) await fs.chmod(path.join(stubBin, name), 0o755)
}

async function removeStub(name: string) {
  await fs.rm(path.join(stubBin, name))
}

function runInstaller({ withStubBin, gitEnv = {} }: { withStubBin: boolean; gitEnv?: Record<string, string> }) {
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
      ...gitEnv,
    },
    extendEnv: false,
  })
}

test.beforeEach(async () => {
  home = await makeTempDir('install-home')
  dest = path.join(home, 'pipelinely')
  stubBin = path.join(home, 'stub-bin')
  callLog = path.join(home, 'calls.log')
  appsDir = path.join(home, 'Applications')
  brewPrefix = path.join(home, 'homebrew')
  await fs.mkdir(path.join(appsDir, 'iTerm.app'), { recursive: true })
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
    expect(calls).toContain(`npm --prefix ${dest} install`)

    const linked = path.join(home, '.claude/skills/pipelinely')
    expect(await fs.lstat(linked).then((s) => s.isSymbolicLink())).toBe(true)
    expect(await fs.realpath(linked)).toBe(await fs.realpath(path.join(dest, '.claude/skills/pipelinely')))
  })

  async function seedExistingCheckout() {
    await execa('git', ['init', '-q', dest]) // real git — only to create a .git dir the fake `git -C ... rev-parse` can see
    await writeFiles(dest, {
      '.claude/skills/pipelinely/SKILL.md': '---\nname: pipelinely\n---\n',
      'dotfiles/lib/install-helpers.sh': await fs.readFile(path.join(REPO_ROOT, 'dotfiles/lib/install-helpers.sh'), 'utf-8'),
    })
  }

  test('an existing clean checkout on main is fast-forwarded, not re-cloned', async () => {
    await seedExistingCheckout()

    const result = await runInstaller({ withStubBin: true })
    expect(result.exitCode, result.all).toBe(0)

    const calls = await fs.readFile(callLog, 'utf-8')
    expect(calls).not.toContain('git clone')
    expect(calls).toContain(`git -C ${dest} pull --ff-only`)
    expect(result.all).toContain('Updated existing checkout')
  })

  test('an existing checkout with local changes is left alone', async () => {
    await seedExistingCheckout()

    const result = await runInstaller({ withStubBin: true, gitEnv: { STUB_GIT_STATUS: ' M src/server.ts' } })
    expect(result.exitCode, result.all).toBe(0)

    expect(await fs.readFile(callLog, 'utf-8')).not.toContain('pull')
    expect(result.all).toContain('skipping update (local changes)')
  })

  test('an existing checkout on another branch is left alone', async () => {
    await seedExistingCheckout()

    const result = await runInstaller({ withStubBin: true, gitEnv: { STUB_GIT_BRANCH: 'my-feature' } })
    expect(result.exitCode, result.all).toBe(0)

    expect(await fs.readFile(callLog, 'utf-8')).not.toContain('pull')
    expect(result.all).toContain('skipping update (not on main)')
  })

  test('failure path: a failed fast-forward is reported but does not abort the install', async () => {
    await seedExistingCheckout()

    const result = await runInstaller({ withStubBin: true, gitEnv: { STUB_GIT_PULL_EXIT: '1' } })
    expect(result.exitCode, result.all).toBe(0)

    expect(result.all).toContain('update failed')
    expect(await fs.readFile(callLog, 'utf-8')).toContain(`npm --prefix ${dest} install`)
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
    expect(await callsSoFar()).toContain(`npm --prefix ${dest} install`)
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
    const result = await runInstaller({ withStubBin: true, gitEnv: { STUB_NODE_VERSION: UNSUPPORTED_NODE_VERSION } })
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
    const result = await runInstaller({ withStubBin: true, gitEnv: { STUB_GH_AUTH_EXIT: '1' } })
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
    const result = await runInstaller({ withStubBin: true, gitEnv: { STUB_UNAME: 'Linux' } })
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
    expect(calls).not.toContain('pull')
    expect(calls).not.toContain('npm ')
  })

  test('failure path: git is only the Command Line Tools shim — reported missing with the xcode-select fix', async () => {
    const result = await runInstaller({ withStubBin: true, gitEnv: { STUB_GIT_VERSION_EXIT: '1' } })
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
    const result = await runInstaller({ withStubBin: true, gitEnv: { STUB_GH_AUTH_HANG: '1', PIPELINELY_GH_TIMEOUT_SECONDS: '1' } })
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
      gitEnv: { HOME: spacedHome, PIPELINELY_APP_DIRS: `${fakeSystemApps}:${spacedHome}/Applications` },
    })
    expect(result.all).not.toContain('iTerm2 not found')
  })

  test('a successful run prints no watchdog job report and a non-numeric gh timeout falls back to the default', async () => {
    const result = await runInstaller({ withStubBin: true, gitEnv: { PIPELINELY_GH_TIMEOUT_SECONDS: 'soon' } })
    expect(result.exitCode, result.all).toBe(0)
    expect(result.stderr).not.toMatch(/Terminated|line \d+:/)
    expect(result.all).toContain('gh signed in')
  })

  test('failure path: node exists but errors on --version — reported, not a crash', async () => {
    const result = await runInstaller({ withStubBin: true, gitEnv: { STUB_NODE_BROKEN: '1' } })
    expect(result.exitCode).not.toBe(0)
    expect(result.all).toContain('20+')
    expect(result.all).toContain('brew install node')
    await expectNothingChanged()
  })

  test('failure path: not macOS — no brew or Homebrew advice is printed', async () => {
    await removeStub('node')
    const result = await runInstaller({ withStubBin: true, gitEnv: { STUB_UNAME: 'Linux' } })
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

    const result = await runInstaller({ withStubBin: true, gitEnv: { PIPELINELY_BREW_PREFIXES: `${brewPrefix}:${intelPrefix}` } })
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

    const result = await runInstaller({ withStubBin: true, gitEnv: { SHELL: '/bin/zsh' } })
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
    expect(await callsSoFar()).toContain(`npm --prefix ${dest} install`)
  })
})
