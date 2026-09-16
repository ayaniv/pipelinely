import fs from 'node:fs/promises'
import path from 'node:path'
import { FIXTURE_TASKS_DIR } from './fixtureDirs.js'

// Routes like /skip-stage, /mark-done and /merge-pr mutate a fixture task's
// STATUS/TIMELINE on disk — this restores each file to its original content
// afterward so the fixture is repeatable across runs, the same care
// withOrchestratorSession (pipeline-stage-cta.spec.ts) already takes for
// ORCHESTRATOR_SESSION.
export async function withRestoredFixtureFiles(slug: string, files: string[], fn: () => Promise<void>): Promise<void> {
  const paths = files.map((f) => path.join(FIXTURE_TASKS_DIR, slug, f))
  const originals = await Promise.all(paths.map((p) => fs.readFile(p, 'utf-8')))
  try {
    await fn()
  } finally {
    await Promise.all(paths.map((p, i) => fs.writeFile(p, originals[i])))
  }
}
