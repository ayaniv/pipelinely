---
name: pipelinely-feedback
description: File feedback about pipelinely as a GitHub issue on ayaniv/pipelinely, including relevant context from what you were just doing. Use when the user says "/pipelinely-feedback", "give feedback", "report a bug", or similar.
allowed-tools: ["Bash"]
---

# Feedback

Turn the user's feedback into a GitHub issue on `ayaniv/pipelinely`, so it
reaches the developer directly — no separate credentials or webhook, just the
`gh` CLI every alpha user already has authenticated (a listed prerequisite in
the README).

## Steps

### 1. Get the feedback

If `$ARGUMENTS` is non-empty, that's the feedback. Otherwise ask the user
what they want to report.

### 2. Add context

Summarize, in a couple of sentences, what the user was doing right before
this: which feature/screen, any error message seen, any relevant command or
task. Pull this from the live conversation itself — do not re-run anything
to reconstruct it. Skip this section entirely if nothing relevant precedes
the feedback (e.g. it's the first message of the session).

### 3. File the issue

```bash
gh issue create --repo ayaniv/pipelinely \
  --title "<one-line summary of the feedback>" \
  --body "<the user's feedback>

---
Context: <the summary from step 2 — omit this whole section if step 2 found nothing relevant>
Filed via /pipelinely-feedback"
```

If this fails — most likely `gh` isn't authenticated — tell the user
directly what happened and suggest `gh auth login`. Do not silently drop the
feedback or claim it was filed when it wasn't.

### 4. Confirm

Print the issue URL `gh issue create` returns, so the user can see it landed.
