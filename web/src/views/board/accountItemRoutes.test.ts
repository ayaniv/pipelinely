import { describe, expect, test } from 'vitest'
import { accountItemForPath } from './accountItemRoutes'

describe('accountItemForPath', () => {
  test.each([
    ['/usage', 'usage'],
    ['/settings', 'settings'],
    ['/docs', 'docs'],
    ['/help', 'help'],
    ['/usage/', 'usage'],
    ['/docs/', 'docs'],
  ])('%s stands for the %s item', (pathname, item) => {
    expect(accountItemForPath(pathname)).toBe(item)
  })

  test.each(['/', '/done', '/backlog', '/task/some-slug', '/nowhere', '/usage/extra', ''])(
    '%s stands for no account item',
    (pathname) => {
      expect(accountItemForPath(pathname)).toBeNull()
    },
  )
})
