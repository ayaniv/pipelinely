import fs from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'
import { REPO_ROOT, pathExists } from './ossSource.js'

// A pipeline skill ships to a fresh install only if it lives under
// .claude/skills/ (oss/allowlist.txt ships that directory whole, and the
// public install.sh symlinks every directory in it) AND oss/rename-map.txt
// renames it to its public pipelinely-* name — without the map line it ships
// still called cockpit-*, which no orchestrator prompt in the public repo
// would ever invoke.
export async function expectSkillPackaged(cockpitName: string): Promise<void> {
  expect(await pathExists(path.join(REPO_ROOT, '.claude', 'skills', cockpitName, 'SKILL.md')), `${cockpitName}/SKILL.md exists`).toBe(true)
  const renameMap = await fs.readFile(path.join(REPO_ROOT, 'oss', 'rename-map.txt'), 'utf-8')
  const publicName = cockpitName.replace(/^cockpit-/, 'pipelinely-')
  expect(renameMap.split('\n')).toContain(`${cockpitName}=${publicName}`)
}
