# Acme Notes data-flow audit

Synthetic fixture: invented product, invented evidence. It only mirrors the *shape* of a real audit (headings, a verdict, and wide tables) so the result-doc parser has something realistic to read.

## 1. Summary and verdict

Acme Notes keeps notes on the user's own machine and makes a small number of outbound requests.

- **Verdict:** no note content leaves the machine unless the user turns on sync.
- **Highest risk:** the optional crash reporter, which can attach a file path.
- **Not verified:** whether the third-party spell-check library makes network calls.

## 2. Data-flow map

### 2.A Acme Notes' own code

| # | Interaction | Trigger | Destination | Default on? | User-initiated? | Can carry | Evidence |
|---|---|---|---|---|---|---|---|
| A1 | `GET /v1/updates` | App start | updates.example.test | Yes | No | App version | `src/updater.ts:12` |
| A2 | `POST /v1/sync` | Sync button | sync.example.test | No (opt-in) | Yes | Note text, note titles | `src/sync.ts:40` |
| A3 | `POST /v1/crash` | Unhandled exception | crash.example.test | No (opt-in) | No | Stack trace, file path | `src/crash.ts:8` |
| A4 | Font `<link>` | Every window open | fonts.example.test | Yes | No | IP address, user agent | `public/index.html:5` |
| A5 | `open <url>` | "Help" menu item | Default browser | No | Yes | Nothing | `src/menu.ts:21` |

### 2.B Third-party pieces

| # | Piece | Relationship | Note |
|---|---|---|---|
| B1 | Spell-check library | Bundled dependency | **Not verified:** network behaviour |
| B2 | Markdown renderer | Bundled dependency | Local only |

### 2.C Local-only reads that could look alarming but are not egress

- Reading the notes folder to build the search index.
- Reading the OS locale to pick a date format.

## 3. Findings

| ID | Severity | Finding | Recommendation |
|---|---|---|---|
| F1 | Medium | The crash reporter can include the absolute path of the open note | Strip the directory before sending |
| F2 | Low | Fonts are loaded from a third-party host on every window open | Self-host the fonts |
| F3 | Info | The update check sends the app version | Document it in the privacy page |

## 4. Open questions

1. Should the crash reporter stay opt-in?
2. Is a self-hosted font bundle acceptable for the release size?
