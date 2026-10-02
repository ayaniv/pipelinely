# Shared brief — durable intent across stages

Synthetic fixture: an invented design document. It mirrors the shape of a real design doc (summary, numbered sections, nested headings, a fenced template with its own headings, tables) and contains no real content.

## Summary and recommendation

Keep one short `BRIEF.md` per task, written once at creation, that every later stage reads first.

- **Recommendation:** option B, a single brief file with an amendments log.
- **Cost:** one new file and one small renderer.
- **Risk:** the brief goes stale if amendments are not appended.

## 1. Current flow

### 1.1 Entry points

| Entry point | Who runs it | Creates |
|---|---|---|
| Form | A person | `TASK.md` |
| Import | A script | `TASK.md`, `STATUS` |

### 1.2 Artifact inventory

| # | Step | Stage | Owner | Artifact | State | Access | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Step 1 | Stage 2 | Owner 2 | `ARTIFACT-1.md` | Present | Read-only | Notes for item 1 |
| 2 | Step 2 | Stage 3 | Owner 3 | `ARTIFACT-2.md` | Present | Read-only | Notes for item 2 |
| 3 | Step 3 | Stage 4 | Owner 1 | `ARTIFACT-3.md` | Present | Read-only | Notes for item 3 |
| 4 | Step 4 | Stage 1 | Owner 2 | `ARTIFACT-4.md` | Present | Read-only | Notes for item 4 |
| 5 | Step 5 | Stage 2 | Owner 3 | `ARTIFACT-5.md` | Present | Read-only | Notes for item 5 |
| 6 | Step 6 | Stage 3 | Owner 1 | `ARTIFACT-6.md` | Present | Read-only | Notes for item 6 |
| 7 | Step 7 | Stage 4 | Owner 2 | `ARTIFACT-7.md` | Present | Read-only | Notes for item 7 |
| 8 | Step 8 | Stage 1 | Owner 3 | `ARTIFACT-8.md` | Present | Read-only | Notes for item 8 |

## 2. Where intent is lost

1. The original request is paraphrased when the plan is written.
2. Reviewers see the plan, not the request.

## 3. Proposed model

### 3.1 Options compared

| Option | Pros | Cons |
|---|---|---|
| A. Keep paraphrasing | No new file | Intent drifts |
| B. Single brief | One source of truth | One more file |
| C. Brief per stage | Tailored | Copies drift apart |

### 3.2 What goes in the brief

```markdown
# Brief: <task title>

## Original request (verbatim)
<pasted text>

## Acceptance criteria
- <criterion>

## Amendments
- <date>: <what changed and why>
```

### 3.3 Who creates it

The dispatcher writes it once; later stages only append amendments.

## 4. Context contract

| Stage | Reads | Must not read |
|---|---|---|
| Plan | Brief | Other tasks |
| Dev | Brief, plan | Review notes |
| Review | Brief, diff | Dev scratch files |

## 5. Migration

Tasks without a brief keep working; the renderer falls back to the task description.

## 6. Open questions

1. Should amendments require sign-off?
2. Is a verbatim copy of the request ever sensitive?
