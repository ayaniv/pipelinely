// pipelinely-design-qa writes DESIGN_QA.md as a table whose Storybook and Figma
// cells name screenshot files under design-qa/ (`design-qa/primary-light.png`,
// bare or as a Markdown image). The approval panel shows those images beside
// the report text, served by GET /task-asset/:slug/design-qa/:file.
const IMAGE_REFERENCE = /design-qa\/([\w.-]+\.(?:png|jpe?g))/gi

// File names (not paths), in report order, each once.
export function designQaImageFiles(report: string | null): string[] {
  if (!report) return []
  const files = [...report.matchAll(IMAGE_REFERENCE)].map((match) => match[1])
  return [...new Set(files)]
}

const IMAGE_FILE_ENDING = /\.(?:png|jpe?g)$/i
const SERVABLE_IMAGE_CELL = /^design-qa\/[\w.-]+\.(?:png|jpe?g)$/i

// Table cells that name an image the panel cannot serve (a space in the name,
// another directory, an absolute path): they are dropped from the screenshots,
// so the panel lists them rather than leave the designer to assume none exist.
export function unservableImageCells(report: string | null): string[] {
  if (!report) return []
  const cells = report.split('\n').filter((line) => line.trimStart().startsWith('|')).flatMap((line) => line.split('|'))
  const imageCells = cells.map((cell) => cell.trim().replace(/^!\[[^\]]*\]\(/, '').replace(/\)$/, '')).filter((cell) => IMAGE_FILE_ENDING.test(cell))
  return [...new Set(imageCells.filter((cell) => !SERVABLE_IMAGE_CELL.test(cell)))]
}

// A report that has table rows but no matched screenshot is probably not in the
// `design-qa/<file>` form, which the panel would otherwise show with no hint why.
export function isReportMissingImages(report: string | null): boolean {
  return !!report && /^\s*\|.*\|\s*$/m.test(report) && designQaImageFiles(report).length === 0
}

export function designQaImageUrl(slug: string, file: string): string {
  return `/task-asset/${encodeURIComponent(slug)}/design-qa/${encodeURIComponent(file)}`
}
