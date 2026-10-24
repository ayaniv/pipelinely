import fs from 'node:fs/promises'
import path from 'node:path'

// Design QA's screenshots live in <task>/design-qa/ in the tasks dir, which is
// outside every static mount, so the dashboard reads them through one route.
// That route serves a single kind of thing — an image file directly inside
// that directory — and this is where "directly inside" is enforced.

export const DESIGN_QA_DIR = 'design-qa'

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

export type DesignQaAsset =
  | { ok: true; filePath: string; contentType: string }
  | { ok: false; status: 400 | 404 }

// A bare file or directory name: no separator, no NUL, not a dot segment.
const MAX_NAME_LENGTH = 255

function isPlainName(name: string): boolean {
  return name !== '' && name.length <= MAX_NAME_LENGTH && name !== '.' && name !== '..' && name === path.basename(name) && !name.includes('\0') && !name.includes('\\')
}

// 400 for anything that is not a plain image name under a plain slug, or that
// resolves (through a symlink) outside the task's own design-qa directory; 404
// for an image that is not there. The realpath comparisons are the guard that
// matters: the name checks alone would let a symlink inside design-qa/ read
// any file the server can, and so would design-qa/ itself being a symlink to
// somewhere outside the task.
export async function resolveDesignQaAsset(tasksDir: string, slug: string, file: string): Promise<DesignQaAsset> {
  const contentType = CONTENT_TYPE_BY_EXTENSION[path.extname(file).toLowerCase()]
  if (!isPlainName(slug) || !isPlainName(file) || !contentType) return { ok: false, status: 400 }

  try {
    const taskDirectory = await fs.realpath(path.join(tasksDir, slug))
    const directory = await fs.realpath(path.join(taskDirectory, DESIGN_QA_DIR))
    if (directory !== path.join(taskDirectory, DESIGN_QA_DIR)) return { ok: false, status: 400 }
    const filePath = await fs.realpath(path.join(directory, file))
    if (path.dirname(filePath) !== directory) return { ok: false, status: 400 }
    if (!(await fs.stat(filePath)).isFile()) return { ok: false, status: 404 }
    return { ok: true, filePath, contentType }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, status: 404 }
    if (code === 'ENAMETOOLONG') return { ok: false, status: 400 }
    throw err
  }
}
