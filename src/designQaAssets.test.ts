import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveDesignQaAsset } from './designQaAssets.js'

describe('resolveDesignQaAsset', () => {
  let tasksDir: string
  const slug = 'ds-task'

  beforeEach(async () => {
    tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-qa-assets-'))
    await fs.mkdir(path.join(tasksDir, slug, 'design-qa'), { recursive: true })
    await fs.writeFile(path.join(tasksDir, slug, 'design-qa', 'primary-light.png'), 'png')
    await fs.writeFile(path.join(tasksDir, slug, 'design-qa', 'notes.txt'), 'not an image')
    await fs.writeFile(path.join(tasksDir, slug, 'STATUS'), 'secret status')
    await fs.writeFile(path.join(tasksDir, slug, 'STATUS.png'), 'a png beside the directory, not inside it')
  })

  afterEach(async () => {
    await fs.rm(tasksDir, { recursive: true, force: true })
  })

  it('serves a PNG directly inside the task\'s design-qa directory', async () => {
    const asset = await resolveDesignQaAsset(tasksDir, slug, 'primary-light.png')
    expect(asset).toEqual({ ok: true, filePath: path.join(await fs.realpath(tasksDir), slug, 'design-qa', 'primary-light.png'), contentType: 'image/png' })
  })

  it('serves JPEG with its own content type', async () => {
    await fs.writeFile(path.join(tasksDir, slug, 'design-qa', 'figma.JPG'), 'jpg')
    expect(await resolveDesignQaAsset(tasksDir, slug, 'figma.JPG')).toMatchObject({ ok: true, contentType: 'image/jpeg' })
  })

  it.each([
    ['../STATUS'],
    ['../STATUS.png'],
    ['/etc/passwd'],
    ['sub/primary-light.png'],
    ['..'],
    [''],
    ['primary-light.png\0.txt'],
  ])('refuses the traversal or non-basename file %j with 400', async (file) => {
    expect(await resolveDesignQaAsset(tasksDir, slug, file)).toEqual({ ok: false, status: 400 })
  })

  it('refuses a file that is not an image, so notes and reports are never served from here', async () => {
    expect(await resolveDesignQaAsset(tasksDir, slug, 'notes.txt')).toEqual({ ok: false, status: 400 })
  })

  it.each([['..'], ['../ds-task'], ['a/b'], ['']])('refuses the traversing slug %j with 400', async (badSlug) => {
    expect(await resolveDesignQaAsset(tasksDir, badSlug, 'primary-light.png')).toEqual({ ok: false, status: 400 })
  })

  it('answers 404 for an image that does not exist', async () => {
    expect(await resolveDesignQaAsset(tasksDir, slug, 'missing.png')).toEqual({ ok: false, status: 404 })
  })

  it('refuses design-qa/ itself being a symlink to a folder outside the task', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'design-qa-outside-'))
    try {
      await fs.writeFile(path.join(outside, 'secret.png'), 'secret')
      const linked = 'linked-task'
      await fs.mkdir(path.join(tasksDir, linked))
      await fs.symlink(outside, path.join(tasksDir, linked, 'design-qa'))

      expect(await resolveDesignQaAsset(tasksDir, linked, 'secret.png')).toEqual({ ok: false, status: 400 })
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.each([[300], [5000]])('answers 400, not a server error, for a %i-character file name', async (length) => {
    expect(await resolveDesignQaAsset(tasksDir, slug, `${'a'.repeat(length)}.png`)).toEqual({ ok: false, status: 400 })
  })

  it('refuses a symlink that points outside the design-qa directory', async () => {
    await fs.symlink(path.join(tasksDir, slug, 'STATUS.png'), path.join(tasksDir, slug, 'design-qa', 'escape.png'))
    expect(await resolveDesignQaAsset(tasksDir, slug, 'escape.png')).toEqual({ ok: false, status: 400 })
  })
})
