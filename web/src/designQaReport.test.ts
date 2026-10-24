import { describe, expect, test } from 'vitest'
import { designQaImageFiles, designQaImageUrl, isReportMissingImages, unservableImageCells } from './designQaReport'

describe('designQaImageFiles', () => {
  test('finds bare table cells and Markdown images, in order, once each', () => {
    const report = [
      '| Primary | Light | design-qa/primary-light.png | design-qa/figma-primary.png | yes |',
      '| Primary | Dark | ![dark](design-qa/primary-dark.PNG) | design-qa/figma-primary.png | no |',
      '| Ghost | Light | design-qa/ghost.jpeg | design-qa/ghost-figma.jpg | yes |',
    ].join('\n')

    expect(designQaImageFiles(report)).toEqual(['primary-light.png', 'figma-primary.png', 'primary-dark.PNG', 'ghost.jpeg', 'ghost-figma.jpg'])
  })

  test('ignores non-image references and a report with no images', () => {
    expect(designQaImageFiles('see design-qa/notes.txt and ../design-qa/x.gif')).toEqual([])
    expect(designQaImageFiles('')).toEqual([])
    expect(designQaImageFiles(null)).toEqual([])
  })
})

describe('designQaImageUrl', () => {
  test('points at the task-asset route, encoding both segments', () => {
    expect(designQaImageUrl('my task', 'a b.png')).toBe('/task-asset/my%20task/design-qa/a%20b.png')
  })
})

describe('isReportMissingImages', () => {
  test('is true for a table whose cells name no design-qa image', () => {
    expect(isReportMissingImages('| Primary | Light | shots/a b.png | shots/f.png | yes |')).toBe(true)
  })

  test('is false when an image is matched, or there is no table or no report', () => {
    expect(isReportMissingImages('| Primary | Light | design-qa/a.png | design-qa/f.png | yes |')).toBe(false)
    expect(isReportMissingImages('All good, nothing to compare.')).toBe(false)
    expect(isReportMissingImages(null)).toBe(false)
  })
})

describe('unservableImageCells', () => {
  test('lists image cells the route cannot serve, once each, unwrapping Markdown images', () => {
    const report = [
      '| Primary | Light | design-qa/ok.png | design-qa/with space.png | yes |',
      '| Primary | Dark | ![x](other/dir/thing.png) | /abs/path.jpg | no |',
      '| Ghost | Light | design-qa/ok.png | other/dir/thing.png | yes |',
    ].join('\n')

    expect(unservableImageCells(report)).toEqual(['design-qa/with space.png', 'other/dir/thing.png', '/abs/path.jpg'])
  })

  test('is empty when every image cell is servable, or there is no report', () => {
    expect(unservableImageCells('| A | B | design-qa/a.png | design-qa/b.JPG | yes |')).toEqual([])
    expect(unservableImageCells(null)).toEqual([])
  })
})
