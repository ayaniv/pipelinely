import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readRepoFile = (name: string) => fs.readFileSync(path.join(repoRoot, name), 'utf8')

describe('MIT license', () => {
  it('ships a LICENSE file with the MIT text and copyright holder', () => {
    const license = readRepoFile('LICENSE')
    expect(license.startsWith('MIT License\n\nCopyright (c) 2026 Yaniv Aharon\n')).toBe(true)
    expect(license).toContain('Permission is hereby granted, free of charge')
    expect(license.endsWith('SOFTWARE.\n')).toBe(true)
  })

  it('declares "license": "MIT" in package.json', () => {
    expect(JSON.parse(readRepoFile('package.json')).license).toBe('MIT')
  })

  it('ends the README with a License section linking LICENSE', () => {
    expect(readRepoFile('README.md').endsWith('## License\n\nMIT — see [LICENSE](LICENSE).\n')).toBe(true)
  })

  it('fails loudly when a license file is missing', () => {
    expect(() => readRepoFile('LICENSE.does-not-exist')).toThrow(/ENOENT/)
  })
})
