---
name: pipelinely-feedback
description: File feedback about pipelinely as a public GitHub issue on ayaniv/pipelinely, after showing the exact text and getting an explicit yes. Use when the user says "/pipelinely-feedback", "give feedback", "report a bug", or similar.
allowed-tools: ["Bash"]
---

# Feedback

Turn the user's feedback into a public GitHub issue on `ayaniv/pipelinely`,
so it reaches the developer directly — no separate credentials or webhook,
just the `gh` CLI every alpha user already has authenticated (a listed
prerequisite in the README). Nothing is posted until the user has seen the
exact text and said yes.

## Steps

### 1. Get the feedback

If `$ARGUMENTS` is non-empty, that's the feedback. Otherwise ask the user
what they want to report.

### 2. Add context

Summarize, in a couple of sentences, what the user was doing right before
this: which feature or screen, and the gist of any error or command involved.
Pull this from the live conversation itself — do not re-run anything to
reconstruct it. Skip the Context section entirely if nothing relevant
precedes the feedback (e.g. it's the first message of the session).

The issue is public, so by default leave out anything that identifies the
user or their work:

- filesystem paths (`/Users/...`, worktree paths)
- usernames and home-directory names
- repository names
- task slugs or titles
- branch names
- PR numbers of the user's own repos
- code from the user's project
- emails, tokens and secrets
- hostnames and IP addresses
- environment variable values
- `gh` auth details: account name, token scopes, `gh auth status` output

Apply this to everything that goes into the issue, including the user's own
feedback text and any error message or command output: paraphrase it or
remove the excluded part before it is included, never paste it raw. Leave
each item out unless the user asked for that specific detail to be included.
Describe the problem generically instead ("the dashboard's merge button was
disabled"); Pipelinely's own file and function names are public, so those
are fine. If the report can't be understood without a detail you left out,
or the user's own text contains one, say so in the preview (step 3) and let
the user decide.

### 3. Preview

Compose the complete issue: the title, and the body ending with the Context
block from step 2 and the footer below (omit the Context line only if
step 2 found nothing relevant):

```
---
Context: <the summary from step 2>
Filed via /pipelinely-feedback
```

Write the title and body to the scratch directory computed by this exact
formula — never `mktemp` or any other random component that only this step
would know, and never anything derived from `$PWD` or another cwd-dependent
command: the working directory is model-controlled shell state, not stable
session environment, so if step 3 and step 5 (or an edit that redoes step 3)
run from different working directories — a `cd` in between, or the harness
resetting the shell's cwd between turns — a `$PWD`-based hash changes and
step 5 silently reads an empty, nonexistent directory:

```bash
FEEDBACK_SESSION_ID="${TMUX_PANE:-$ITERM_SESSION_ID}"
if [ -z "$FEEDBACK_SESSION_ID" ]; then
  echo "Neither TMUX_PANE nor ITERM_SESSION_ID is set, so there is no stable per-session identifier to derive a private scratch path from. Refusing, rather than falling back to a path another concurrent session could share — tell the user and stop here." >&2
  exit 1
fi
FEEDBACK_DIR="$HOME/.pipelinely-feedback/$(printf '%s' "$FEEDBACK_SESSION_ID" | shasum -a 256 | cut -c1-16)"
if [ -L "$FEEDBACK_DIR" ]; then
  echo "$FEEDBACK_DIR is a symlink, not a plain directory. Refusing to use it — tell the user and stop here." >&2
  exit 1
fi
mkdir -p -m 700 "$FEEDBACK_DIR"
chmod 700 "$FEEDBACK_DIR"
```

If either check prints and exits, stop the whole `/pipelinely-feedback` flow right
there and tell the user plainly why — do not fall back to a shared or
predictable path, and do not follow the symlink.

This pipeline runs several tabs at once, each in its own worktree — a fixed,
shared path (`/tmp/pipelinely-feedback` or similar) lets one session's
`/pipelinely-feedback` overwrite another's mid-flow, so a user could end up posting a
different session's text after confirming their own preview. Keying solely
on the terminal session (`TMUX_PANE` or `ITERM_SESSION_ID`, both stable for
the life of this session and already set in the environment before the
skill ever runs, not something this step assigns) gives a path that is
unique per concurrent invocation, exactly reconstructable regardless of
which directory either step happens to run from, with no shell variable
needing to survive into a later step. `$HOME` with mode `700` (enforced by
`chmod` even if the directory pre-exists) keeps it out of world-writable
`/tmp`, where another local user could pre-create or symlink it — the
symlink check above refuses that specific attempt rather than following it
and `chmod`ing the attacker's target.

Then write the files with a quoted heredoc, so the shell expands nothing in
the text:

```bash
cat > "$FEEDBACK_DIR/title.txt" <<'FEEDBACK_EOF'
<title>
FEEDBACK_EOF
cat > "$FEEDBACK_DIR/body.md" <<'FEEDBACK_EOF'
<body, ending with the Context block and footer>
FEEDBACK_EOF
```

Then preview by reading those exact files back — never by reprinting your
own composed text, which can drift from what actually landed on disk:

```bash
cat "$FEEDBACK_DIR/title.txt"
cat "$FEEDBACK_DIR/body.md"
```

Print that output in a single fenced block — the whole text including the
footer, not a summary. Directly below the block, say in one plain sentence
that this will be posted publicly on github.com/ayaniv/pipelinely and
visible to everyone. Name any details from step 2 that the report needs or
that the user's own text contained.

### 4. Confirm

**STOP AND WAIT.** Ask the user whether to post it, then end your turn and
wait for the user's reply. Do not post in the same turn as the preview.

Only an explicit yes given after the preview posts the issue. Consent given
before the preview does not count — not "/pipelinely-feedback X and just post it", not
an earlier "go ahead". Anything else — silence, a question, a maybe — means
do not post.

- **Edit request:** redo step 3 in full — recompute `FEEDBACK_DIR`, the same
  quoted-heredoc write to it, then `cat` it back for the new preview. Never
  patch the files with `echo` or a double-quoted string, which would expand
  backticks, `$(...)`, `$VAR` and quotes in the edited text. Any edit
  re-triggers the preview and this stop.
- **Cancel, or no explicit yes:** say plainly that nothing was posted,
  recompute `FEEDBACK_DIR` (the formula in step 3) and `rm -rf "$FEEDBACK_DIR"`,
  and stop.

### 5. File the issue

Post the files written in step 3, unchanged. Recompute `FEEDBACK_DIR` with
the exact formula from step 3 (the session-id check included — if it
refuses here too, stop and tell the user, same as step 3). No shell
variable survived from step 3's turn, but the formula's own input
(`$TMUX_PANE`/`$ITERM_SESSION_ID`) is the session's own environment, not
state this skill set, and never `$PWD`, so it lands on the same path
regardless of which directory this step happens to run from:

```bash
FEEDBACK_SESSION_ID="${TMUX_PANE:-$ITERM_SESSION_ID}"
if [ -z "$FEEDBACK_SESSION_ID" ]; then
  echo "Neither TMUX_PANE nor ITERM_SESSION_ID is set; refusing to guess a scratch path another session could share." >&2
  exit 1
fi
FEEDBACK_DIR="$HOME/.pipelinely-feedback/$(printf '%s' "$FEEDBACK_SESSION_ID" | shasum -a 256 | cut -c1-16)"
gh issue create --repo ayaniv/pipelinely \
  --title "$(cat "$FEEDBACK_DIR/title.txt")" \
  --body-file "$FEEDBACK_DIR/body.md"
```

Add nothing and change nothing after the preview — the posted text is
exactly the confirmed text, footer included, because this step reads it from
the same files, not from a re-composed copy. Never pass the body inline —
not `--body`, not `-b`, not `--body=...` — where backticks, `$(...)`,
`$VAR`, quotes and `!` would be expanded by the shell; `--body-file` is the
only form that posts the literal file contents.

If this fails — most likely `gh` isn't installed, isn't authenticated, or is
offline — tell the user directly what happened (suggest `gh auth login` for
authentication) and that nothing was posted. Do not silently drop the
feedback or claim it was filed when it wasn't, and do not delete
`$FEEDBACK_DIR` — a failed or abandoned session leaves its scratch files in
place by design, so a retry can reuse them. Retrying is fine only with the
same files and the user's fresh yes; if the text changes, go back to step 3.

### 6. Report

Print the issue URL `gh issue create` returns, so the user can see it
landed. Only now, after a confirmed successful post, recompute
`FEEDBACK_DIR` and `rm -rf "$FEEDBACK_DIR"` — never on a failure, which
step 5 leaves in place for a retry.
