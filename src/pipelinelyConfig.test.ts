import { describe, test, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  buildPipelineConfig,
  renderPipelineYaml,
  writeProjectConfig,
  renderConstraintsMarkdown,
} from './pipelinelyConfig.js'
import type { DetectedProject } from './pipelinelyDetect.js'

const baseDetected: DetectedProject = {
  isGitRepo: true,
  repoRoot: '/tmp/widgets',
  remoteUrl: 'git@github.com:acme/widgets.git',
  defaultBranch: 'main',
  hasClaudeMd: false,
  existingSkillDirs: [],
  packageManager: 'npm',
  scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
  e2eFramework: 'playwright',
}

describe('buildPipelineConfig', () => {
  test('default 5 stages, without plan-review', () => {
    const config = buildPipelineConfig(baseDetected, false)
    expect(config.stages).toEqual(['planning', 'dev', 'code-review', 'qa', 'merge'])
    expect(config.test).toBe('vitest run')
  })

  test('plan-review inserted right after planning when enabled', () => {
    const config = buildPipelineConfig(baseDetected, true)
    expect(config.stages).toEqual(['planning', 'plan-review', 'dev', 'code-review', 'qa', 'merge'])
  })
})

describe('renderPipelineYaml', () => {
  test('renders a readable, minimal YAML — no library dependency needed for this shape', () => {
    const yaml = renderPipelineYaml({ stages: ['planning', 'dev', 'code-review', 'qa', 'merge'], test: 'vitest run', lint: null, typecheck: null })
    expect(yaml).toBe(
      'stages:\n  - planning\n  - dev\n  - code-review\n  - qa\n  - merge\ncommands:\n  test: vitest run\n  lint: null\n  typecheck: null\n'
    )
  })
})

describe('renderConstraintsMarkdown', () => {
  test('merges the default template with a detected CLAUDE.md, the project\'s own content wins on conflict by appending after', () => {
    const result = renderConstraintsMarkdown('# Defaults\n- write tests', '# This project\n- use tabs')
    expect(result).toBe('# Defaults\n- write tests\n\n## This project\'s own conventions (from CLAUDE.md)\n\n# This project\n- use tabs')
  })

  test('no CLAUDE.md — just the default template, unmodified', () => {
    expect(renderConstraintsMarkdown('# Defaults\n- write tests', null)).toBe('# Defaults\n- write tests')
  })
})

describe('writeProjectConfig', () => {
  test('writes .pipelinely/pipeline.yml and .pipelinely/engineering-constraints.md into the target dir', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-config-'))
    await writeProjectConfig(dir, { stages: ['planning', 'dev', 'code-review', 'qa', 'merge'], test: 'vitest run', lint: null, typecheck: null }, '# constraints')
    expect(await fs.readFile(path.join(dir, '.pipelinely/pipeline.yml'), 'utf-8')).toContain('stages:')
    expect(await fs.readFile(path.join(dir, '.pipelinely/engineering-constraints.md'), 'utf-8')).toBe('# constraints')
    await fs.rm(dir, { recursive: true, force: true })
  })
})
