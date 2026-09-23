import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import fs from 'node:fs'
import path from 'node:path'
import { validateToolbox } from './validateToolbox.js'

const TOOLBOX_DIR = path.join(import.meta.dirname, '..', 'toolbox')
const schema = JSON.parse(fs.readFileSync(path.join(TOOLBOX_DIR, 'schema.json'), 'utf8'))

const VALID_ENTRY = `  - id: some-tool
    name: Some Tool
    description: Does one useful thing.
    url: https://github.com/example/some-tool
    stage: dev
    type: tool
`

const registryOf = (entries: string): string => `tools:\n${entries}`
// cockpit-ai has no toolbox/registry.yml of its own (that content is
// pipelinely-only) — this fixture stands in for it wherever the original,
// pipelinely-side test read the real file.
const sampleRegistryYaml = registryOf(VALID_ENTRY)

describe('validateToolbox', () => {
  let validEntry: string

  beforeEach(() => {
    validEntry = VALID_ENTRY
  })

  describe('happy path', () => {
    it('accepts a valid registry', () => {
      expect(validateToolbox(sampleRegistryYaml, schema)).toEqual([])
    })

    it('accepts an entry with the optional author field', () => {
      expect(validateToolbox(registryOf(`${validEntry}    author: example\n`), schema)).toEqual([])
    })

    it.each(['planning', 'dev', 'code-review', 'qa'])('accepts stage %s', (stage) => {
      const yaml = registryOf(validEntry.replace('stage: dev', `stage: ${stage}`))
      expect(validateToolbox(yaml, schema)).toEqual([])
    })

    it.each(['tool', 'skill', 'plugin', 'integration'])('accepts type %s', (type) => {
      const yaml = registryOf(validEntry.replace('type: tool', `type: ${type}`))
      expect(validateToolbox(yaml, schema)).toEqual([])
    })
  })

  describe('failure paths', () => {
    it('reports a missing required field', () => {
      const yaml = registryOf(validEntry.replace(/ {4}name: .*\n/, ''))
      const errors = validateToolbox(yaml, schema)
      expect(errors.join('\n')).toContain("must have required property 'name'")
    })

    it('reports a stage outside the enum', () => {
      const errors = validateToolbox(registryOf(validEntry.replace('stage: dev', 'stage: shipping')), schema)
      expect(errors.join('\n')).toContain('/tools/0/stage')
    })

    it('reports a type outside the enum', () => {
      const errors = validateToolbox(registryOf(validEntry.replace('type: tool', 'type: widget')), schema)
      expect(errors.join('\n')).toContain('/tools/0/type')
    })

    it('reports a malformed id', () => {
      const errors = validateToolbox(registryOf(validEntry.replace('id: some-tool', 'id: Some_Tool')), schema)
      expect(errors.join('\n')).toContain('/tools/0/id')
    })

    it('reports duplicate ids', () => {
      const errors = validateToolbox(registryOf(validEntry + validEntry), schema)
      expect(errors.join('\n')).toContain('duplicate id "some-tool"')
    })

    it('reports an http:// url', () => {
      const yaml = registryOf(validEntry.replace('https://github', 'http://github'))
      expect(validateToolbox(yaml, schema).join('\n')).toContain('/tools/0/url')
    })

    it('reports a malformed url', () => {
      const yaml = registryOf(validEntry.replace('https://github.com/example/some-tool', 'https://not a url'))
      expect(validateToolbox(yaml, schema).join('\n')).toContain('/tools/0/url')
    })

    it('reports an unknown key', () => {
      const errors = validateToolbox(registryOf(`${validEntry}    stars: 5\n`), schema)
      expect(errors.join('\n')).toContain('must NOT have additional properties')
    })

    it('reports an over-long description', () => {
      const yaml = registryOf(validEntry.replace('Does one useful thing.', 'x'.repeat(201)))
      expect(validateToolbox(yaml, schema).join('\n')).toContain('/tools/0/description')
    })

    it('reports tools that is not an array', () => {
      expect(validateToolbox('tools: nope\n', schema).join('\n')).toContain('/tools')
    })

    it('points a schema error at its line in registry.yml', () => {
      const errors = validateToolbox(registryOf(validEntry.replace('stage: dev', 'stage: shipping')), schema)
      expect(errors.join('\n')).toContain('(line 6)')
    })

    it('points a missing-field error at the entry it belongs to', () => {
      const errors = validateToolbox(registryOf(validEntry.replace(/ {4}name: .*\n/, '')), schema)
      expect(errors.join('\n')).toContain('(line 2)')
    })

    it('points a duplicate-id error at the repeated id', () => {
      const errors = validateToolbox(registryOf(validEntry + validEntry), schema)
      expect(errors.join('\n')).toContain('duplicate id "some-tool" (line 8)')
    })

    it('reports invalid YAML with a line number', () => {
      const errors = validateToolbox('tools:\n  - id: [unclosed\n', schema)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/YAML parse error.*line \d+/)
    })
  })
})

describe('validate:toolbox CLI', () => {
  const REPO_ROOT = path.join(import.meta.dirname, '..')
  const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
  const EXIT_INVALID = 1
  let checkoutDir: string

  // The directory name has a space on purpose: the entry-point guard once
  // compared a percent-encoded file URL to a raw path and silently never ran.
  beforeEach(() => {
    checkoutDir = fs.mkdtempSync(path.join(REPO_ROOT, 'cli check '))
    fs.mkdirSync(path.join(checkoutDir, 'scripts'))
    fs.mkdirSync(path.join(checkoutDir, 'toolbox'))
    fs.copyFileSync(path.join(import.meta.dirname, 'validateToolbox.ts'), path.join(checkoutDir, 'scripts', 'validateToolbox.ts'))
    fs.copyFileSync(path.join(TOOLBOX_DIR, 'schema.json'), path.join(checkoutDir, 'toolbox', 'schema.json'))
  })

  afterEach(() => {
    fs.rmSync(checkoutDir, { recursive: true, force: true })
  })

  const runCli = (registryYaml?: string) => {
    if (registryYaml !== undefined) fs.writeFileSync(path.join(checkoutDir, 'toolbox', 'registry.yml'), registryYaml)
    return execa(TSX_BIN, [path.join(checkoutDir, 'scripts', 'validateToolbox.ts')], { reject: false })
  }

  it('exits 0 and reports valid for a valid registry', async () => {
    const result = await runCli(sampleRegistryYaml)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('is valid')
  })

  it('exits non-zero and prints the error for an invalid registry', async () => {
    const result = await runCli(registryOf(VALID_ENTRY.replace('id: some-tool', 'id: BAD')))
    expect(result.exitCode).toBe(EXIT_INVALID)
    expect(result.stderr).toContain('/tools/0/id')
  })

  it('exits non-zero when the registry file is missing', async () => {
    const result = await runCli()
    expect(result.exitCode).toBe(EXIT_INVALID)
    expect(result.stderr).toContain('failed to run')
  })

  it('runs the entry-point guard through a symlink to the script', async () => {
    // import.meta.url reports the realpath of the loaded module, but
    // process.argv[1] keeps the symlink path — the guard must resolve both
    // the same way or it silently never runs.
    fs.writeFileSync(path.join(checkoutDir, 'toolbox', 'registry.yml'), registryOf(VALID_ENTRY.replace('id: some-tool', 'id: BAD')))
    const symlinkPath = path.join(checkoutDir, 'validate-link.ts')
    fs.symlinkSync(path.join(checkoutDir, 'scripts', 'validateToolbox.ts'), symlinkPath)
    const result = await execa(TSX_BIN, [symlinkPath], { reject: false })
    expect(result.exitCode).toBe(EXIT_INVALID)
    expect(result.stderr).toContain('/tools/0/id')
  })
})
