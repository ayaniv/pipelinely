import fs from 'node:fs/promises'
import path from 'node:path'
import type { DetectedProject } from './pipelinelyDetect.js'

export interface PipelineConfig {
  stages: string[]
  test: string | null
  lint: string | null
  typecheck: string | null
}

const DEFAULT_STAGES = ['planning', 'dev', 'code-review', 'qa', 'merge']

export function buildPipelineConfig(detected: DetectedProject, includePlanReview: boolean): PipelineConfig {
  const stages = includePlanReview
    ? ['planning', 'plan-review', ...DEFAULT_STAGES.slice(1)]
    : [...DEFAULT_STAGES]
  return { stages, test: detected.scripts.test, lint: detected.scripts.lint, typecheck: detected.scripts.typecheck }
}

export function renderPipelineYaml(config: PipelineConfig): string {
  const stageLines = config.stages.map((s) => `  - ${s}`).join('\n')
  const fmt = (v: string | null) => (v === null ? 'null' : v)
  return `stages:\n${stageLines}\ncommands:\n  test: ${fmt(config.test)}\n  lint: ${fmt(config.lint)}\n  typecheck: ${fmt(config.typecheck)}\n`
}

export function renderConstraintsMarkdown(defaultTemplate: string, detectedClaudeMd: string | null): string {
  if (detectedClaudeMd === null) return defaultTemplate
  return `${defaultTemplate}\n\n## This project's own conventions (from CLAUDE.md)\n\n${detectedClaudeMd}`
}

export async function writeProjectConfig(targetDir: string, config: PipelineConfig, constraintsMarkdown: string): Promise<void> {
  const configDir = path.join(targetDir, '.pipelinely')
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(path.join(configDir, 'pipeline.yml'), renderPipelineYaml(config))
  await fs.writeFile(path.join(configDir, 'engineering-constraints.md'), constraintsMarkdown)
}
