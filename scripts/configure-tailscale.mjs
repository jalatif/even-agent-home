import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const backendPort = process.env.BACKEND_PORT ?? '8787'
const vitePort = process.env.VITE_PORT ?? '5173'

const ip = process.env.TAILSCALE_IP ?? detectTailscaleIp()
const backendOrigin = `http://${ip}:${backendPort}`
const frontendOrigin = `http://${ip}:${vitePort}`

const appJsonPath = join(repoRoot, 'app.json')
const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'))
const networkPermission = appJson.permissions?.find((permission) => permission.name === 'network')
if (!networkPermission) {
  throw new Error('app.json is missing the network permission.')
}
// The shipped manifest carries a runtime placeholder (`http://<BACKEND_URL>:8787`)
// so the .ehpk does not bake in a per-developer IP. Local device testing
// swaps that placeholder for this machine's real Tailscale IP right before
// packaging; other developers (or the App Store) ship the placeholder as-is.
const placeholder = 'http://<BACKEND_URL>:8787'
const whitelist = networkPermission.whitelist ?? []
const placeholderIndex = whitelist.indexOf(placeholder)
if (placeholderIndex === -1) {
  throw new Error(`app.json network whitelist is missing the ${placeholder} placeholder.`)
}
whitelist[placeholderIndex] = backendOrigin
networkPermission.whitelist = unique(whitelist)
writeFileSync(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`)

console.log(`Tailscale backend URL: ${backendOrigin}`)
console.log(`Tailscale frontend URL: ${frontendOrigin}`)
console.log('Updated app.json network whitelist.')
console.log('Set this Backend URL in Agent Home Settings if needed:')
console.log(backendOrigin)

function detectTailscaleIp() {
  try {
    return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split(/\s+/)[0]
  } catch (error) {
    throw new Error('Could not detect Tailscale IPv4 address. Install/login to Tailscale or set TAILSCALE_IP.')
  }
}

function unique(values) {
  return [...new Set(values)]
}
