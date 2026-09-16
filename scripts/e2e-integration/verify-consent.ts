// Lets run.sh's --dry-run flag prove "yes actually works" without opening a
// single window: run.sh performs the TTY check, prints the warning, prompts,
// and mints a real consent token exactly as a real run does, then executes
// this script instead of Playwright. This calls the real guard against real
// env — the only thing swapped is what runs after consent is established.
import { assertIsolatedEnvironment } from '../../src/e2eIsolation.js'

assertIsolatedEnvironment()
console.log('CONSENT_ACCEPTED')
