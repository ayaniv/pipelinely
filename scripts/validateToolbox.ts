import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { LineCounter, parseDocument, type Document } from 'yaml'

const TOOLBOX_DIR = path.join(import.meta.dirname, '..', 'toolbox')
const EXIT_INVALID = 1

interface RegistryEntry {
  id: string
}

/** " (line N)" for the node at `path`, or "" when the node has no source position. */
function lineSuffix(document: Document, lineCounter: LineCounter, path: (string | number)[]): string {
  const node = document.getIn(path, true)
  const offset = node && typeof node === 'object' && 'range' in node ? node.range?.[0] : undefined
  return offset === undefined ? '' : ` (line ${lineCounter.linePos(offset).line})`
}

/** Ajv reports JSON pointers ("/tools/2/url"); the yaml document is indexed by path segments. */
function pointerToPath(pointer: string): (string | number)[] {
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment))
}

/** Returns every problem found in the registry YAML; an empty list means valid. */
export function validateToolbox(yamlText: string, schema: object): string[] {
  const lineCounter = new LineCounter()
  const document = parseDocument(yamlText, { lineCounter })
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
      (error) =>
        `${error.instancePath || '/'} ${error.message}${lineSuffix(document, lineCounter, pointerToPath(error.instancePath))}`,
    )
  }

  // JSON Schema's uniqueItems can't compare a single key, so ids are checked by hand.
  const seenIds = new Set<string>()
  const duplicateErrors: string[] = []
  ;(registry.tools as RegistryEntry[]).forEach((tool, index) => {
    if (seenIds.has(tool.id)) {
      duplicateErrors.push(`duplicate id "${tool.id}"${lineSuffix(document, lineCounter, ['tools', index, 'id'])}`)
    }
    seenIds.add(tool.id)
  })
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) runCli()
