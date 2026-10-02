import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// S1 pinned against a future refactor: the only code that may type into a
// worker's pane is reachable from the explicit-click route handler, never from
// the auto-advance pass, the approval poll, or any timer.

const SRC_DIR = __dirname
const WEB_SRC_DIR = path.join(__dirname, '..', 'web', 'src')
const SOURCE_FILE = /\.tsx?$/
const TEST_FILE = /\.test\.tsx?$/

function listProductionSources(dir: string): { file: string; text: string }[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => SOURCE_FILE.test(file) && !TEST_FILE.test(file))
    .map((file) => ({ file, text: fs.readFileSync(path.join(dir, file), 'utf8') }))
}

const productionSources = listProductionSources(SRC_DIR)

const webSources = listProductionSources(WEB_SRC_DIR)

const filesIn = (sources: { file: string; text: string }[], pattern: RegExp) => sources.filter(({ text }) => pattern.test(text)).map(({ file }) => file).sort()
const filesMatching = (pattern: RegExp) => filesIn(productionSources, pattern)

describe('who may type into a worker pane', () => {
  it('calls answerDialog( only from the route handler and its own module', () => {
    expect(filesMatching(/\banswerDialog\(/)).toEqual(['dialogAnswer.ts', 'server.ts'])
  })

  it('references sendKeysToPane only in the answer module and its own definition', () => {
    expect(filesMatching(/\bsendKeysToPane\b/)).toEqual(['dialogAnswer.ts', 'focusTab.ts'])
  })

  it('spells the tmux write subcommand in focusTab.ts and nowhere else', () => {
    expect(filesMatching(/['"`]send-keys['"`]/)).toEqual(['focusTab.ts'])
  })

  it.each(['autoActions.ts', 'approvalWatch.ts', 'approvalPrompt.ts'])('keeps %s free of any answer or send path', (file) => {
    const source = productionSources.find((candidate) => candidate.file === file)
    expect(source, `${file} should exist`).toBeDefined()
    expect(source!.text).not.toMatch(/dialogAnswer|\banswerDialog\b|\bsendKeysToPane\b|['"`]send-keys['"`]/)
  })

  it('registers the answer route as POST only', () => {
    const server = productionSources.find(({ file }) => file === 'server.ts')!.text
    expect(server).toMatch(/app\.post\('\/answer-dialog\/:slug'/)
    expect(server).not.toMatch(/app\.(get|all|put|patch|delete)\('\/answer-dialog/)
  })
})

// The dashboard half of S1: the client may only ask for a send from a click.
describe('who may ask the server to answer a dialog', () => {
  const ANSWER_BUTTONS = path.join('views', 'board', 'ApprovalAnswerButtons.tsx')

  it('calls postAnswerDialog( only from its definition and the answer buttons', () => {
    expect(filesIn(webSources, /\bpostAnswerDialog\(/)).toEqual([path.join('api', 'actions.ts'), ANSWER_BUTTONS])
  })

  it('names the answer route only in postAnswerDialog', () => {
    expect(filesIn(webSources, /answer-dialog/)).toEqual([path.join('api', 'actions.ts')])
  })

  it('calls it once in the answer buttons, from a click handler and never from an effect or timer', () => {
    const source = webSources.find(({ file }) => file === ANSWER_BUTTONS)!.text
    expect(source.match(/\bpostAnswerDialog\(/g)).toHaveLength(1)
    expect(source.match(/\banswer\(/g)).toEqual(['answer('])
    expect(source).toMatch(/onClick=\{\(\) => answer\(option\)\}/)
    expect(source).not.toMatch(/\buseEffect\b|\buseLayoutEffect\b|\bsetTimeout\b|\bsetInterval\b|\bautoFocus\b/)
  })
})

describe('the source scan', () => {
  it('reaches sources in subdirectories, so a nested send path cannot slip past it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-scan-test-'))
    try {
      fs.mkdirSync(path.join(dir, 'nested'))
      fs.writeFileSync(path.join(dir, 'top.ts'), '')
      fs.writeFileSync(path.join(dir, 'nested', 'deep.ts'), '')
      fs.writeFileSync(path.join(dir, 'nested', 'deep.test.ts'), '')
      fs.writeFileSync(path.join(dir, 'nested', 'view.tsx'), '')
      fs.writeFileSync(path.join(dir, 'nested', 'view.test.tsx'), '')
      expect(listProductionSources(dir).map(({ file }) => file).sort()).toEqual([path.join('nested', 'deep.ts'), path.join('nested', 'view.tsx'), 'top.ts'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
