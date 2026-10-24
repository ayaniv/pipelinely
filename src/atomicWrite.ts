import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface AtomicWriteOptions {
  fileMode?: number
  dirMode?: number
}

// Writes a temp file beside the target and renames it into place, so a
// reader or an interrupted write never sees a half-written file. The temp
// name is unique per call: two writers to one path (two tabs) can't clobber
// each other's temp file.
export function writeFileAtomicSync(filePath: string, content: string, { fileMode, dirMode }: AtomicWriteOptions = {}): void {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    const dirPath = path.dirname(filePath)
    fs.mkdirSync(dirPath, { recursive: true, mode: dirMode })
    // mkdir's mode only applies to a folder it creates; one that already
    // existed wider (0755) would otherwise stay listable.
    if (dirMode !== undefined) fs.chmodSync(dirPath, dirMode)
    fs.writeFileSync(tempPath, content, { mode: fileMode })
    fs.renameSync(tempPath, filePath)
    // writeFile's mode only applies on creation and is cut by the umask;
    // this makes the final file's mode exact.
    if (fileMode !== undefined) fs.chmodSync(filePath, fileMode)
  } catch (err) {
    fs.rmSync(tempPath, { force: true })
    throw err
  }
}
