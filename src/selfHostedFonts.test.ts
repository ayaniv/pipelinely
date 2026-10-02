import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// The dashboard used to load Figtree and JetBrains Mono from Google Fonts,
// which leaked the user's IP / User-Agent / Referer to a third party on every
// page load. These tests pin that the fonts are self-hosted and that no remote
// font host can creep back into anything the dashboard ships.

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB_DIR = path.join(REPO_ROOT, 'web')
const FONTS_DIR = path.join(WEB_DIR, 'public', 'fonts')
const APP_CSS_PATH = path.join(WEB_DIR, 'src', 'styles', 'app.css')
const BUILT_DIST_DIR = path.join(REPO_ROOT, 'public', 'dist')

// Hosts that only ever serve fonts/CDN assets, flagged wherever they appear.
const REMOTE_FONT_HOST_PATTERN = /googleapis|gstatic|fonts\.google|bunny\.net|typekit|fontawesome|cdnjs|jsdelivr|unpkg/i
const REMOTE_URL_PATTERN = /^(?:https?:)?\/\//i
const REMOTE_IMPORT_PATTERN = /@import\s+(?:url\()?\s*['"]?(?:https?:)?\/\/[^\s'")]+/gi
const REMOTE_FONT_FACE_SRC_PATTERN = /@font-face\s*\{[^}]*url\(\s*['"]?(?:https?:)?\/\/[^)]*\)/gi
const LINK_TAG_PATTERN = /<link\b[^>]*>/gi
// A <link> with one of these rels makes the browser contact the href's host
// before/while loading the page, so a third-party href leaks like a font fetch.
const CONTACTING_LINK_RELS = /\brel=["'][^"']*\b(?:preconnect|dns-prefetch|preload|prefetch|modulepreload|stylesheet)\b/i
const WOFF2_MAGIC = 'wOF2'
// Latin-subset woff2 files are ~10-25 KB each; anything near this cap means a
// full (multi-script) font slipped in.
const MAX_FONT_FILE_BYTES = 60 * 1024
const BUILD_TIMEOUT_MS = 120_000

// Exactly the weights the old Google Fonts <link> requested (normal style only).
const EXPECTED_WEIGHTS_BY_FAMILY: Record<string, number[]> = {
  Figtree: [400, 500, 600, 700, 800],
  'JetBrains Mono': [400, 500, 600, 700],
}
const LICENSE_FILES = ['OFL-Figtree.txt', 'OFL-JetBrainsMono.txt']
const TEXT_FILE_PATTERN = /\.(html|css|js|mjs|ts|tsx|json|svg)$/

// Textual scan: it only sees URLs written literally in the source, so a URL
// assembled at runtime (e.g. a template-literal interpolation) is invisible to
// it. Returns every remote font/CDN reference in `text`: a known font/CDN host, an
// @import or @font-face src of a remote URL, or a <link> that preconnects /
// preloads / stylesheets a third-party host.
function findRemoteFontReferences(text: string): string[] {
  const hostHits = text.split('\n').filter((line) => REMOTE_FONT_HOST_PATTERN.test(line))
  const importHits = text.match(REMOTE_IMPORT_PATTERN) ?? []
  const fontFaceHits = text.match(REMOTE_FONT_FACE_SRC_PATTERN) ?? []
  const linkHits = (text.match(LINK_TAG_PATTERN) ?? []).filter((tag) => {
    const href = /\bhref=["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
    return CONTACTING_LINK_RELS.test(tag) && REMOTE_URL_PATTERN.test(href)
  })
  return [...hostHits, ...importHits, ...fontFaceHits, ...linkHits]
}

function listFilesRecursively(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    return entry.isDirectory() ? listFilesRecursively(fullPath) : [fullPath]
  })
}

interface FontFaceRule {
  family: string
  weight: number
  display: string
  srcUrls: string[]
}

function parseFontFaceRules(css: string): FontFaceRule[] {
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) ?? []
  return blocks.map((block) => ({
    family: /font-family:\s*['"]([^'"]+)['"]/.exec(block)?.[1] ?? '',
    weight: Number(/font-weight:\s*(\d+)/.exec(block)?.[1]),
    display: /font-display:\s*(\w+)/.exec(block)?.[1] ?? '',
    srcUrls: [...block.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((match) => match[1]),
  }))
}

const fontFaceRules = parseFontFaceRules(fs.readFileSync(APP_CSS_PATH, 'utf8'))

describe('the remote-font-host scanner', () => {
  it.each([
    ['a Google Fonts stylesheet link', '<link href="https://fonts.googleapis.com/css2?family=Figtree" rel="stylesheet">'],
    ['a gstatic preconnect', '<link rel="preconnect" href="https://fonts.gstatic.com">'],
    ['a bunny.net font host', "src: url('https://fonts.bunny.net/figtree/files/figtree-400.woff2')"],
    ['a typekit stylesheet', '<link rel="stylesheet" href="https://use.typekit.net/abc1def.css">'],
    ['a jsdelivr font URL', "src: url('https://cdn.jsdelivr.net/npm/@fontsource/figtree/files/x.woff2')"],
    ['an unpkg font URL', "src: url('https://unpkg.com/@fontsource/figtree/files/x.woff2')"],
    ['a cdnjs font URL', "src: url('https://cdnjs.cloudflare.com/ajax/libs/x/y.woff2')"],
    ['a remote @import url()', "@import url('https://example.com/fonts.css');"],
    ['a remote bare @import', '@import "//example.com/fonts.css";'],
    ['a remote @font-face src', "@font-face { font-family: 'X'; src: url(https://example.com/x.woff2); }"],
    ['a remote stylesheet link on a non-font host', '<link rel="stylesheet" href="https://evil.example/x.css">'],
    ['a preconnect to any third-party host', '<link rel="preconnect" href="https://example.com">'],
    ['a dns-prefetch to a protocol-relative host', '<link rel="dns-prefetch" href="//example.com">'],
    ['a multi-line link with href before rel', '<link\n  href="https://example.com/x"\n  rel="preload" as="font">'],
  ])('flags %s', (_label, snippet) => {
    expect(findRemoteFontReferences(snippet)).not.toEqual([])
  })

  it.each([
    ['a same-origin @font-face src', "src: url('/fonts/figtree-latin-400-normal.woff2')"],
    ['a same-origin font preload', '<link rel="preload" as="font" type="font/woff2" href="/fonts/x.woff2" crossorigin>'],
    ['a same-origin stylesheet', '<link rel="stylesheet" href="/assets/index.css">'],
    ['an outbound documentation anchor', '<a href="https://example.com/docs">docs</a>'],
    ['a canonical link (does not contact the host)', '<link rel="canonical" href="https://example.com/">'],
  ])('passes %s', (_label, snippet) => {
    expect(findRemoteFontReferences(snippet)).toEqual([])
  })
})

describe('no remote font host in what the dashboard ships', () => {
  const shippedSourceFiles = [
    path.join(WEB_DIR, 'index.html'),
    path.join(REPO_ROOT, 'public', 'index.html'),
    ...listFilesRecursively(path.join(WEB_DIR, 'public')),
    ...listFilesRecursively(path.join(WEB_DIR, 'src')),
    ...listFilesRecursively(path.join(REPO_ROOT, 'public', 'art')),
    // server.ts carries HTML/CSS templates, and docs/ can hold HTML/MJS
    // snippets — both are places a leftover font link could hide.
    path.join(REPO_ROOT, 'src', 'server.ts'),
    ...listFilesRecursively(path.join(REPO_ROOT, 'docs')),
  ].filter((filePath) => fs.existsSync(filePath) && TEXT_FILE_PATTERN.test(filePath))

  it('scans a non-empty set of shipped source files', () => {
    expect(shippedSourceFiles.length).toBeGreaterThan(10)
  })

  it.each(shippedSourceFiles.map((filePath) => [path.relative(REPO_ROOT, filePath), filePath]))(
    '%s has no googleapis/gstatic reference',
    (_relativePath, filePath) => {
      expect(findRemoteFontReferences(fs.readFileSync(filePath, 'utf8'))).toEqual([])
    },
  )
})

describe('@font-face rules in app.css', () => {
  it('declares exactly the weights the old Google Fonts link requested, per family', () => {
    const weightsByFamily: Record<string, number[]> = {}
    for (const rule of fontFaceRules) {
      weightsByFamily[rule.family] = [...(weightsByFamily[rule.family] ?? []), rule.weight].sort()
    }
    expect(weightsByFamily).toEqual(EXPECTED_WEIGHTS_BY_FAMILY)
  })

  it('uses font-display: swap on every rule so text never blocks on the font', () => {
    expect(fontFaceRules.length).toBeGreaterThan(0)
    for (const rule of fontFaceRules) expect(rule.display).toBe('swap')
  })

  it('points every src at a same-origin /fonts/ path', () => {
    for (const rule of fontFaceRules) {
      expect(rule.srcUrls.length).toBeGreaterThan(0)
      for (const url of rule.srcUrls) expect(url).toMatch(/^\/fonts\/[\w-]+\.woff2$/)
    }
  })

  it('points every src at a file that exists in the repo', () => {
    for (const rule of fontFaceRules) {
      for (const url of rule.srcUrls) {
        expect(fs.existsSync(path.join(WEB_DIR, 'public', url)), `${url} is missing`).toBe(true)
      }
    }
  })
})

describe('the self-hosted font files', () => {
  const fontFiles = fs.existsSync(FONTS_DIR) ? fs.readdirSync(FONTS_DIR).filter((name) => name.endsWith('.woff2')) : []

  it('ships one file per declared weight and nothing extra', () => {
    const declaredFiles = fontFaceRules.flatMap((rule) => rule.srcUrls.map((url) => path.basename(url))).sort()
    expect(fontFiles.sort()).toEqual(declaredFiles)
  })

  it.each(fontFiles)('%s is a real woff2 under the size cap', (fileName) => {
    const bytes = fs.readFileSync(path.join(FONTS_DIR, fileName))
    expect(bytes.subarray(0, 4).toString('latin1')).toBe(WOFF2_MAGIC)
    expect(bytes.length).toBeLessThan(MAX_FONT_FILE_BYTES)
  })

  it.each(LICENSE_FILES)('%s carries the SIL OFL 1.1 text next to the fonts', (fileName) => {
    const licensePath = path.join(FONTS_DIR, fileName)
    expect(fs.existsSync(licensePath), `${fileName} is missing`).toBe(true)
    const license = fs.readFileSync(licensePath, 'utf8')
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(license).toMatch(/Copyright/)
  })
})

describe('the served dashboard', () => {
  let handle: TestServerHandle

  beforeAll(async () => {
    // The server serves Vite's build output, so build it for real — it is the
    // only way to prove the fonts survive the public/ passthrough into dist/.
    execFileSync('npm', ['run', 'build:web'], { cwd: REPO_ROOT, stdio: 'pipe' })
    handle = await startTestServer()
  }, BUILD_TIMEOUT_MS)

  afterAll(async () => {
    if (handle) await stopTestServer(handle)
  })

  const fetchFromServer = (urlPath: string) => fetch(`http://127.0.0.1:${handle.boundPort}${urlPath}`)

  it('serves a font file as font/woff2 with a cache lifetime', async () => {
    const response = await fetchFromServer('/fonts/figtree-latin-400-normal.woff2')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('font/woff2')
    expect(response.headers.get('cache-control')).toMatch(/max-age=\d+/)
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes.subarray(0, 4).toString('latin1')).toBe(WOFF2_MAGIC)
  })

  it('does not set a CSP that would block same-origin fonts', async () => {
    const response = await fetchFromServer('/')
    const csp = response.headers.get('content-security-policy') ?? ''
    // Only font-src, or default-src as its fallback, can restrict fonts; the
    // remote-auth gate's frame-ancestors-only policy does not.
    for (const directive of ['font-src', 'default-src']) {
      const value = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${directive} `))
      if (value !== undefined) expect(value, directive).toContain("'self'")
    }
  })

  it('404s a font that does not exist instead of falling through to the SPA shell', async () => {
    const response = await fetchFromServer('/fonts/not-a-real-font.woff2')
    expect(response.status).toBe(404)
  })

  it('serves an HTML shell with no remote font host', async () => {
    const html = await (await fetchFromServer('/')).text()
    expect(findRemoteFontReferences(html)).toEqual([])
  })

  it('has no remote font host anywhere in the built output', () => {
    const builtTextFiles = listFilesRecursively(BUILT_DIST_DIR).filter((filePath) => TEXT_FILE_PATTERN.test(filePath))
    expect(builtTextFiles.length).toBeGreaterThan(0)
    for (const filePath of builtTextFiles) {
      expect(findRemoteFontReferences(fs.readFileSync(filePath, 'utf8')), path.relative(REPO_ROOT, filePath)).toEqual([])
    }
  })
})
