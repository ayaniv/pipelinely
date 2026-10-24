---
name: pipelinely-bookmark
description: Save something from this Claude session to read later — the previous answer (verbatim, read from this session's transcript), a pasted quote, or a pointer to this session. Use when the user says "/pipelinely-bookmark", "bookmark this", "save that", or similar.
allowed-tools: ["Bash"]
---

# Bookmark

Saves one bookmark as a small JSON file under `~/.config/pipelinely/bookmarks/`
on this Mac, through `npm run bookmarks`. Nothing is sent anywhere.

Pick the way in from what the user typed after `/pipelinely-bookmark`:

| User typed | Command | Saved |
|---|---|---|
| nothing, or "save that" | `add-last` | the previous answer, read verbatim from this session's own transcript |
| pasted text | `add-text` | that text |
| `session [title]` | `add-session` | a pointer to this session and its task |

## Shell safety — read before running anything

Everything the user typed, and every title, note or tag you write, is free
text and can contain quotes, backticks and `$(…)`. So:

- Text reaches `add-text` only as **stdin from a quoted heredoc** on the same
  line as the command.
- Each title, note and tags value is read from its own quoted heredoc with
  `IFS= read -r -d '' VAR <<'BOOKMARK_EOF' || true` and passed only as a
  double-quoted variable. Never use `VAR=$(cat <<…)`: macOS's stock bash 3.2
  looks for the closing `)` before it reads the heredoc, so a `)` in the text
  would run the rest as shell. Never write `--title "…"` with the
  text inline.
- Never put the user's arguments into a shell command any other way.
- **The delimiter must not appear in the text.** A heredoc ends at the first
  line that is exactly `BOOKMARK_EOF`, and everything after it then runs as a
  shell command. Before writing a block, check whether any line of the text
  (or of the title, note or tags) is exactly `BOOKMARK_EOF`. If one is, use a
  different delimiter such as `BOOKMARK_EOF_7f3a91`, in
  both the opening and the closing line of that block, and check the new one
  is not in the text either.

## Save the previous answer

```bash
IFS= read -r -d '' BOOKMARK_TITLE <<'BOOKMARK_EOF' || true
A short title for the answer, or leave this empty to use its first line
BOOKMARK_EOF
npm --prefix $HOME/Dev/pipelinely run --silent bookmarks -- add-last --title "$BOOKMARK_TITLE"
```

If the title would be empty, drop the `BOOKMARK_TITLE` lines and the `--title`
flag. If it exits non-zero with "no earlier answer" or "transcript not found",
say so and ask the user to paste the text, then use the next section.

## Save pasted text

The quote is re-typed by you into the heredoc, so it is usually exact but not
guaranteed byte-exact. Say so if the text was long or unusual.

```bash
npm --prefix $HOME/Dev/pipelinely run --silent bookmarks -- add-text <<'BOOKMARK_EOF'
the pasted text, exactly as the user gave it
BOOKMARK_EOF
```

## Save this session

```bash
IFS= read -r -d '' BOOKMARK_TITLE <<'BOOKMARK_EOF' || true
What this session is worth coming back to
BOOKMARK_EOF
npm --prefix $HOME/Dev/pipelinely run --silent bookmarks -- add-session --title "$BOOKMARK_TITLE"
```

The session id and task come from the environment, never from you.

## Optional note and tags

Add them the same way, each from its own quoted heredoc:

```bash
IFS= read -r -d '' BOOKMARK_TITLE <<'BOOKMARK_EOF' || true
the title
BOOKMARK_EOF
IFS= read -r -d '' BOOKMARK_NOTE <<'BOOKMARK_EOF' || true
why the user wants to keep it
BOOKMARK_EOF
IFS= read -r -d '' BOOKMARK_TAGS <<'BOOKMARK_EOF' || true
style,parsing
BOOKMARK_EOF
npm --prefix $HOME/Dev/pipelinely run --silent bookmarks -- add-session --title "$BOOKMARK_TITLE" --note "$BOOKMARK_NOTE" --tags "$BOOKMARK_TAGS"
```

Tags are comma-separated lower-case words, at most ten.

## After saving

Relay the CLI's one-line result, and for text bookmarks echo the first line of
what was saved, so a wrong "previous answer" is visible at once.

## What this cannot do

- It cannot see text the user highlighted in the terminal. They should copy it
  and paste it after `/pipelinely-bookmark`.
- Only the last answer can be saved directly; anything earlier has to be pasted.
- `add-last` and `add-session` need Claude Code's session id; in a plain shell
  they fail with a clear message.
- List or delete with `npm --prefix $HOME/Dev/pipelinely run --silent bookmarks -- list`
  and `… -- rm <id>`.
