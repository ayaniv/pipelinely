import { execa } from 'execa'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// A stand-in for the real `claude` binary, used only so a scratch tmux pane
// can genuinely reproduce what `pane_current_command` reports for the real
// CLI — a version-named executable (e.g. `2.1.251`), NOT the literal string
// "claude" (see Change 4 in tech-design.md). The installer puts the real
// executable at `~/.local/share/claude/versions/<version>` and points
// `~/.local/bin/claude` at it as a symlink, so tmux resolves the symlink and
// names the process after the version file, not the `claude` symlink itself.
// This fixture reproduces exactly that shape: a version-named binary behind
// a `claude`-named symlink. Confirmed empirically (macOS, tmux 3.7b) that
// nothing short of a distinctly-named real executable works for the binary
// half of this:
//   - a shebang script reports its INTERPRETER's name (`bash`), not the
//     script's own — the kernel execve's the interpreter, and tmux reads
//     that process's name, not the script path.
//   - a symlink -> /bin/sleep reports `sleep` — tmux/the kernel resolve the
//     symlink before naming the process. (This is also exactly why the
//     `claude` symlink itself is safe to launch through here: it resolves to
//     the version-named binary, reproducing the real reading.)
//   - copying (or hard-linking) an existing Apple-signed system binary and
//     renaming the copy builds a file that *runs* standalone, but gets
//     SIGKILLed the instant tmux (or anything else) execs it — Apple-signed
//     binaries enforce their own canonical path.
// A binary this fixture compiles and ad-hoc-signs itself (clang's default
// for a locally built binary) has none of those problems — so this fixture
// is standing in for the real shape, not a fake shape of its own.

const FAKE_CLAUDE_VERSION = '2.1.251'

let fakeClaudePath: Promise<string> | null = null

async function buildFakeClaude(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-fake-claude-'))
  const src = path.join(dir, 'fake_claude.c')
  const versionedBin = path.join(dir, FAKE_CLAUDE_VERSION)
  const claudeSymlink = path.join(dir, 'claude')
  // Sleeps forever rather than exiting — needs to still be the pane's
  // foreground process by the time the test's HTTP round trip reaches it.
  await fs.writeFile(src, '#include <unistd.h>\nint main(void) { for (;;) sleep(60); }\n')
  await execa('cc', ['-o', versionedBin, src])
  await fs.symlink(versionedBin, claudeSymlink)
  return claudeSymlink
}

// Cached for the life of the test run — one compile, reused by every test
// that needs a "pane is really running claude" tmux session. Returns the
// `claude` symlink, not the version-named binary directly — launching
// through the symlink (as the real install shape does) is what makes the
// pane report the version string rather than the literal "claude".
export async function fakeClaudeBinaryPath(): Promise<string> {
  if (!fakeClaudePath) fakeClaudePath = buildFakeClaude()
  return fakeClaudePath
}
