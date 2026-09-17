import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectProject } from './pipelinelyDetect.js'
import { validateEnvironment } from './pipelinelyValidate.js'
import { buildPipelineConfig, writeProjectConfig, renderConstraintsMarkdown } from './pipelinelyConfig.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function main() {
  const [, , targetDir, ...flags] = process.argv
  if (!targetDir) {
    console.error('Usage: pipelinely-onboard <target-dir> [--confirm-plan-review=<true|false>]')
    process.exit(1)
  }

  const resolvedTargetDir = path.resolve(targetDir)
  if (!(await exists(resolvedTargetDir))) {
    console.error(`Target directory does not exist: ${resolvedTargetDir}`)
    process.exitCode = 1
    return
  }

  const detected = await detectProject(resolvedTargetDir)
  const configBaseDir = detected.repoRoot && detected.repoRoot !== resolvedTargetDir ? detected.repoRoot : resolvedTargetDir

  // Check against configBaseDir (the resolved repo root), not resolvedTargetDir —
  // config is always written at the repo root, so a subdirectory target must be
  // checked at the same place the write eventually lands (see Ruling 17). This
  // runs before the isGitRepo gate below: reporting "already onboarded" is a
  // pure status check and shouldn't require git-repo-ness — only continuing
  // on to actually (re)run onboarding should.
  const pipelineYmlPath = path.join(configBaseDir, '.pipelinely/pipeline.yml')
  const alreadyOnboarded = await exists(pipelineYmlPath)
  if (alreadyOnboarded) {
    console.log(JSON.stringify({ alreadyOnboarded: true }))
    return
  }

  if (!detected.isGitRepo) {
    console.error(`Target directory is not a git repository: ${resolvedTargetDir}`)
    process.exitCode = 1
    return
  }

  const validation = await validateEnvironment()
  const ambiguous: string[] = ['plan-review'] // always ambiguous — the skill always asks, per the spec (§6)
  if (!detected.scripts.test) ambiguous.push('test-command')
  if (!detected.scripts.lint) ambiguous.push('lint-command')
  if (!detected.scripts.typecheck) ambiguous.push('typecheck-command')

  const confirmFlag = flags.find((f) => f.startsWith('--confirm-plan-review='))
  if (!confirmFlag) {
    console.log(JSON.stringify({ alreadyOnboarded: false, detected, validation, ambiguous }))
    return
  }

  const confirmValue = confirmFlag.split('=')[1]
  if (confirmValue !== 'true' && confirmValue !== 'false') {
    console.error(`--confirm-plan-review must be exactly "true" or "false", got: ${confirmValue}`)
    process.exitCode = 1
    return
  }
  const includePlanReview = confirmValue === 'true'

  if (!validation.ok) {
    console.log(JSON.stringify({ configWritten: false, validation }))
    return
  }

  const config = buildPipelineConfig(detected, includePlanReview)
  const claudeMdPath = path.join(configBaseDir, 'CLAUDE.md')
  const claudeMd = detected.hasClaudeMd ? await fs.readFile(claudeMdPath, 'utf-8') : null
  const defaultTemplate = await fs.readFile(path.join(__dirname, '..', 'docs/engineering-constraints.md'), 'utf-8')
  await writeProjectConfig(configBaseDir, config, renderConstraintsMarkdown(defaultTemplate, claudeMd))
  console.log(JSON.stringify({ configWritten: true }))
}

// detectProject's fs.readdir and writeProjectConfig's fs.mkdir/fs.writeFile
// aren't wrapped in try/catch anywhere upstream and can throw on realistic
// conditions (permission-denied target dir, disk full, an exists()/write
// symlink race) — without this handler that surfaces as a raw unhandled-
// rejection stack trace instead of the single clean stderr line the
// /pipelinely SKILL.md needs when it parses this CLI's output.
main().catch((err) => {
  console.error(errorMessage(err))
  process.exitCode = 1
})
