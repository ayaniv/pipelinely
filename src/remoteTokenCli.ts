import os from 'node:os'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import {
  generateRemoteToken,
  readRemoteToken,
  resolveRemoteTokenPath,
  writeRemoteToken,
} from './remoteToken.js'

const USAGE = 'Usage: remote-token [status|create|rotate|show|disable]'

const SIGN_IN_INSTRUCTIONS =
  'Open the dashboard on the device, paste this token into the sign-in page once, and it stays signed in for 30 days.'

function describeToken(action: string, token: string, tokenFile: string): string {
  return [`${action} (${tokenFile}):`, '', token, '', SIGN_IN_INSTRUCTIONS].join('\n')
}

async function createToken(tokenFile: string): Promise<string> {
  if ((await readRemoteToken(tokenFile)) !== null) {
    throw new Error(`A token already exists at ${tokenFile}. Run 'remote-token rotate' to replace it (this signs out every device).`)
  }
  const token = generateRemoteToken()
  await writeRemoteToken(tokenFile, token)
  return describeToken('Remote access is on. Token created', token, tokenFile)
}

async function rotateToken(tokenFile: string): Promise<string> {
  const token = generateRemoteToken()
  await writeRemoteToken(tokenFile, token)
  return describeToken('Token rotated; every signed-in device is signed out. New token', token, tokenFile)
}

async function showToken(tokenFile: string): Promise<string> {
  const token = await readRemoteToken(tokenFile)
  if (token === null) throw new Error(`Remote access is off: no token at ${tokenFile}. Run 'remote-token create' first.`)
  return describeToken('Token', token, tokenFile)
}

async function disableRemoteAccess(tokenFile: string): Promise<string> {
  await fs.rm(tokenFile, { force: true })
  return `Remote access is off (${tokenFile} removed).`
}

async function remoteAccessStatus(tokenFile: string): Promise<string> {
  const isOn = (await readRemoteToken(tokenFile)) !== null
  return isOn
    ? `Remote access is on (token at ${tokenFile}).`
    : `Remote access is off (no token at ${tokenFile}). Run 'remote-token create' to turn it on.`
}

// Returns what to print; throws for anything that should exit non-zero.
export async function runRemoteTokenCommand(command: string | undefined, tokenFile: string): Promise<string> {
  switch (command) {
    case undefined:
    case 'status':
      return remoteAccessStatus(tokenFile)
    case 'create':
      return createToken(tokenFile)
    case 'rotate':
      return rotateToken(tokenFile)
    case 'show':
      return showToken(tokenFile)
    case 'disable':
      return disableRemoteAccess(tokenFile)
    default:
      throw new Error(`${USAGE} — unknown command '${command}'`)
  }
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2)
  const tokenFile = resolveRemoteTokenPath(process.env, os.homedir())
  try {
    console.log(await runRemoteTokenCommand(command, tokenFile))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
