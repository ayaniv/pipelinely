# Engineering constraints

The baseline every `cockpit-*` skill copies verbatim into a dispatched
`TASK.md`'s `## Engineering Constraints` section. Edit this one file to
change what every future dispatch expects — nothing else needs to change.

This is what this pipeline expects for any target repo it dispatches
into. A developer's own personal preferences (e.g. a global
`~/.claude/CLAUDE.md`) fill in anything this file doesn't cover, but don't
override what's stated here — customize this file directly instead of
relying on a personal file to override it for this pipeline specifically.

- **Test coverage:** cover all new functionality with tests for both happy and failure paths, using the repo's existing test framework.
- **Test timing:** write tests before the code they verify, at both granularities this pipeline uses. At the e2e level, `cockpit-planning` commits the e2e specs (tagged `@pending`, expected to fail) before `cockpit-dev` ever starts implementing, and `cockpit-dev` must run them first and confirm they fail for the right reason before writing any implementation code. At the implementation level, follow `superpowers:test-driven-development`'s red-green-refactor loop for every function/behavior change: write the failing test, watch it fail, then write only the minimal code to pass — never write tests after the code already exists.
- **Error observability:** any fallible operation must handle and log errors so failures are observable.
- **Conventions:** follow the target repo's existing patterns (logging, analytics, styling, state, testing) rather than introducing new ones. If the repo has an existing analytics/logging abstraction, new user-facing actions must call into it — never fall back to ad-hoc `console.log`/direct vendor SDK calls when an abstraction already exists.
- **Test selectors:** never select elements by text content in tests. Use a `data-testid` attribute instead — add one if it doesn't already exist.
- **No duplication:** never copy a function or logic body — extract shared behavior into one function/helper the moment a second call site needs the same thing, adding a parameter for whatever varies rather than forking a copy.
