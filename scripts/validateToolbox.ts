import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import fs from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'

const TOOLBOX_DIR = path.join(import.meta.dirname, '..', 'toolbox')
const EXIT_INVALID = 1

interface RegistryEntry {
  id: string
}

/** Returns every problem found in the registry YAML; an empty list means valid. */
export function validateToolbox(yamlText: string, schema: object): string[] {
  const document = parseDocument(yamlText)
  if (document.errors.length > 0) {
    return document.errors.map((error) => {
      const line = error.linePos?.[0].line
      return `YAML parse error${line ? ` at line ${line}` : ''}: ${error.message}`
    })
  }

  const registry = document.toJS()
  const ajv = new Ajv2020({ allErrors: true })
  addFormats(ajv)
  const validateAgainstSchema = ajv.compile(schema)
  if (!validateAgainstSchema(registry)) {
    return (validateAgainstSchema.errors ?? []).map(
      (error) => `${error.instancePath || '/'} ${error.message}`,
    )
  }

  // JSON Schema's uniqueItems can't compare a single key, so ids are checked by hand.
  const seenIds = new Set<string>()
  const duplicateErrors: string[] = []
  for (const tool of registry.tools as RegistryEntry[]) {
    if (seenIds.has(tool.id)) duplicateErrors.push(`duplicate id "${tool.id}"`)
    seenIds.add(tool.id)
  }
  return duplicateErrors
}

function runCli(): void {
  try {
    const schema = JSON.parse(fs.readFileSync(path.join(TOOLBOX_DIR, 'schema.json'), 'utf8'))
    const yamlText = fs.readFileSync(path.join(TOOLBOX_DIR, 'registry.yml'), 'utf8')
    const errors = validateToolbox(yamlText, schema)
    if (errors.length > 0) {
      for (const error of errors) console.error(`toolbox/registry.yml: ${error}`)
      process.exit(EXIT_INVALID)
    }
    console.log('toolbox/registry.yml is valid')
  } catch (error) {
    console.error('validate:toolbox failed to run:', error)
    process.exit(EXIT_INVALID)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runCli()
