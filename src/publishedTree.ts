import fs from 'node:fs'
import path from 'node:path'

// oss/publish.sh never ships oss/, so its publish script is the one file that
// tells master from the tree published to pipelinely. Tests that read files
// the publish renames or drops resolve them here rather than each re-deriving
// the rename, and on master the paths stay exactly the original ones, so a
// deleted file still fails the read instead of silently falling back.
const PUBLISH_SCRIPT = path.join('oss', 'publish.sh')

export function isPublishedTree(repoRoot: string): boolean {
  return !fs.existsSync(path.join(repoRoot, PUBLISH_SCRIPT))
}

// The publish renames the feedback skill (oss/rename-map.txt).
export function feedbackSkillPath(repoRoot: string): string {
  const skillName = isPublishedTree(repoRoot) ? 'pipelinely-feedback' : 'feedback'
  return path.join(repoRoot, '.claude', 'skills', skillName, 'SKILL.md')
}

// The published README is oss/overlay/README.md copied over README.md.
export function shippedReadmePath(repoRoot: string): string {
  return isPublishedTree(repoRoot) ? path.join(repoRoot, 'README.md') : path.join(repoRoot, 'oss', 'overlay', 'README.md')
}
