import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { validateToolbox } from './validateToolbox.js'

const TOOLBOX_DIR = path.join(import.meta.dirname, '..', 'toolbox')
const schema = JSON.parse(fs.readFileSync(path.join(TOOLBOX_DIR, 'schema.json'), 'utf8'))
const realRegistryYaml = fs.readFileSync(path.join(TOOLBOX_DIR, 'registry.yml'), 'utf8')

const VALID_ENTRY = `  - id: some-tool
    name: Some Tool
    description: Does one useful thing.
    url: https://github.com/example/some-tool
    stage: dev
    type: tool
`

const registryOf = (entries: string): string => `tools:\n${entries}`

describe('validateToolbox', () => {
  let validEntry: string

  beforeEach(() => {
    validEntry = VALID_ENTRY
  })

  describe('happy path', () => {
    it('accepts the real registry', () => {
      expect(validateToolbox(realRegistryYaml, schema)).toEqual([])
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

    it('reports invalid YAML with a line number', () => {
      const errors = validateToolbox('tools:\n  - id: [unclosed\n', schema)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/YAML parse error.*line \d+/)
    })
  })
})
