import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { shippedReadmePath } from './publishedTree.js'

const ROOT = path.join(import.meta.dirname, '..')
const NOT_UPDATED_BANNER = 'pipelinely was NOT updated.'
const INSTALL_ONE_LINER = 'curl -fsSL https://pipelinely.cc/install.sh | sh'

describe('shipped README install section', () => {
  let readme: string

  beforeAll(() => {
    readme = fs.readFileSync(shippedReadmePath(ROOT), 'utf-8')
  })

  it('tells users that re-running the one-liner updates, and to restart Claude Code only when the installer says so', () => {
    expect(readme).toContain('**Updating:**')
    expect(readme).toContain('npm ci')
    expect(readme).toContain('restart Claude Code')
    expect(readme).toContain('the installer says')
    expect(readme).not.toContain('Restart Claude Code afterwards')
  })

  it('documents the exact NOT updated banner and the recovery path', () => {
    expect(readme).toContain(`**\`${NOT_UPDATED_BANNER}\`**`)
    expect(readme).toContain('git -C ~/Dev/pipelinely switch main')
    expect(readme).toContain('before re-running')
  })

  it('failure path: no longer promises an unconditional "always picks up your latest checkout"', () => {
    expect(readme).not.toContain('always picks up your')
  })

  it('keeps the one-liner itself', () => {
    expect(readme).toContain(INSTALL_ONE_LINER)
  })
})
