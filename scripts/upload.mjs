#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..')

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : (args[i + 1] ?? true)
}
const hasFlag = (name) => args.includes(`--${name}`)
const changelog = flag('changelog') ?? flag('m') ?? ''
const publishFlag = hasFlag('publish') || hasFlag('create')
const endpoint = flag('endpoint') ?? `https://hub.evenrealities.com/api/v1/versions/draft?package_id=${projectId()}`
const help = hasFlag('help') || hasFlag('h')

if (help) {
  console.log(`
Usage: node scripts/upload.mjs [options]

Uploads the built .ehpk for the current app.json version to the EvenHub
developer portal.

Options:
  --project-id <id>      Override project_id from app.json
  --publish, --create    After upload, create the version as private build
  --changelog, -m <msg>  Changelog message for the version
  --skip-build           Skip the build+pack step
  --dry-run              Show what would be uploaded without doing it
  -h, --help             Show this help
`)
  process.exit(0)
}

// ── Token from evenhub login ──────────────────────────────
// ── YAML helper: read a top-level scalar key, handling block scalar (|-, >-, etc.) ──
function readYamlValue(raw, key) {
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(new RegExp(`^${key}:\\s*(.*)$`))
    if (!m) continue
    const inline = m[1].trim()
    // Plain inline value (not a block scalar indicator)
    if (inline && !/^[|>][-+]?$/.test(inline)) return inline
    // Block scalar: read indented continuation line(s)
    let value = ''
    for (let j = i + 1; j < lines.length; j++) {
      const cont = lines[j]
      if (cont.startsWith('  ') && cont.trim().length > 0) {
        if (value) value += cont.trim() // concat multi-line blocks
        else value = cont.trim()
      } else if (cont.trim() === '') {
        continue // skip blank lines within block
      } else {
        break // next top-level key
      }
    }
    return value || null
  }
  return null
}

// ── Token from evenhub login ──────────────────────────────
function readToken() {
  const yamlPath = join(homedir(), '.config', 'evenhub', 'credentials.yaml')
  if (existsSync(yamlPath)) {
    try {
      const raw = readFileSync(yamlPath, 'utf8')
      return readYamlValue(raw, 'access_token')
    } catch { /* corrupt file */ }
  }
  // Fallback: JSON config from older CLI versions
  const paths = [
    join(homedir(), '.evenhub', 'config.json'),
    join(homedir(), '.config', 'evenhub', 'config.json'),
  ]
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const config = JSON.parse(readFileSync(p, 'utf8'))
        if (config.token) return config.token
        if (config.access_token) return config.access_token
      } catch { /* corrupt file, skip */ }
    }
  }
  return null
}

// ── Token refresh ─────────────────────────────────────────
async function refreshToken(refreshToken) {
  const resp = await fetch('https://hub.evenrealities.com/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  if (!resp.ok) return null
  const data = await resp.json()
  if (data.code !== 0) return null
  const newAccess = data.data.access_token
  const newRefresh = data.data.refresh_token
  // Save tokens back to YAML so the next run uses fresh tokens
  const yamlPath = join(homedir(), '.config', 'evenhub', 'credentials.yaml')
  if (existsSync(yamlPath)) {
    let raw = readFileSync(yamlPath, 'utf8')
    raw = raw.replace(/^access_token: >-\n  .+$/m, `access_token: >-\n  ${newAccess}`)
    if (newRefresh) {
      raw = raw.replace(/^refresh_token: >-\n  .+$/m, `refresh_token: >-\n  ${newRefresh}`)
    }
    writeFileSync(yamlPath, raw, 'utf8')
  }
  return newAccess
}

function readRefreshToken() {
  const yamlPath = join(homedir(), '.config', 'evenhub', 'credentials.yaml')
  if (existsSync(yamlPath)) {
    try {
      const raw = readFileSync(yamlPath, 'utf8')
      return readYamlValue(raw, 'refresh_token')
    } catch { /* corrupt */ }
  }
  return null
}


// ── Project ID from app.json ──────────────────────────────
function projectId() {
  if (flag('project-id')) return flag('project-id')
  const appJsonPath = join(repoRoot, 'app.json')
  if (!existsSync(appJsonPath)) {
    console.error('❌ app.json not found at', appJsonPath)
    process.exit(1)
  }
  const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'))
  return appJson.package_id
}

// ── Version from app.json ─────────────────────────────────
function readAppVersion() {
  const appJsonPath = join(repoRoot, 'app.json')
  const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'))
  return appJson.version
}

async function uploadPackage() {
  // 1. Token
  let token = readToken()
  if (!token) {
    console.error("❌ No authentication token found. Run 'npx @evenrealities/evenhub-cli login' first.")
    process.exit(1)
  }

  // 2. Build + pack (unless skipped)
  let packagePath
  if (hasFlag('skip-build')) {
    packagePath = findEhpk()
    if (!packagePath) {
      console.error('❌ No .ehpk file found. Run build first or omit --skip-build.')
      process.exit(1)
    }
  } else {
    packagePath = buildAndPack()
  }

  if (!existsSync(packagePath)) {
    console.error(`❌ Package not found: ${packagePath}`)
    process.exit(1)
  }

  const fileBuffer = readFileSync(packagePath)
  const fileName = basename(packagePath)
  const fileSize = statSync(packagePath).size
  const pid = projectId()
  console.log(`📋 Package: ${fileName} (${(fileSize / 1024).toFixed(1)} KB)`)
  console.log(`📋 Project: ${pid}`)

  if (hasFlag('dry-run')) {
    console.log('🏁 Dry run complete (not uploaded).')
    return
  }

  // 3. Multipart form body (field name "ehpk" per EvenHub API)
  const boundary = makeBoundary()
  const CRLF = '\r\n'
  const header = [
    `--${boundary}${CRLF}`,
    `Content-Disposition: form-data; name="ehpk"; filename="${fileName}"${CRLF}`,
    `Content-Type: application/octet-stream${CRLF}`,
    CRLF,
  ].join('')
  const footer = `${CRLF}--${boundary}--${CRLF}`

  const headerBuf = Buffer.from(header, 'utf8')
  const footerBuf = Buffer.from(footer, 'utf8')
  const body = Buffer.concat([headerBuf, fileBuffer, footerBuf])

  console.log(`🚀 Uploading to EvenHub...`)

  const doUpload = async (authToken) => {
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-CLI-Version': '0.1.13',
        'Accept': 'application/json',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-Even-Authorization': authToken,
      },
      body,
    })
  }

  try {
    let response = await doUpload(token)

    // Auto-refresh on 401
    if (response.status === 401) {
      const rt = readRefreshToken()
      if (rt) {
        console.log('🔄 Token expired, refreshing...')
        const newToken = await refreshToken(rt)
        if (newToken) {
          token = newToken
          response = await doUpload(token)
        }
      }
    }
    if (response.ok) {
      const data = await response.json()
      const draftId = data.data?.draft_id
      console.log('✅ Upload successful!')
      console.log(`   Draft ID: ${draftId}`)
      console.log(`   Version:  ${data.data?.manifest?.version}`)

      // Step 2: Create the version to make it a private build
      if (publishFlag && draftId) {
        console.log(`📢 Creating version (private build)...`)
        const createForm = new FormData()
        createForm.append('draft_id', draftId)
        if (changelog) createForm.append('changelog', changelog)

        const createResp = await fetch(
          `https://hub.evenrealities.com/api/v1/versions/create?package_id=${pid}`,
          {
            method: 'POST',
            headers: {
              'X-CLI-Version': '0.1.13',
              'Accept': 'application/json',
              'X-Even-Authorization': token,
            },
            body: createForm,
          }
        )

        if (createResp.ok) {
          const createData = await createResp.json()
          console.log('✅ Version created as private build!')
          console.log(`   Version ID: ${createData.data?.id}`)
          console.log(`   Status:     ${createData.data?.is_private ? 'Private (Test)' : 'Public'}`)
        } else {
          const text = await createResp.text()
          console.error(`❌ Version creation failed (HTTP ${createResp.status}):`, text)
          process.exit(1)
        }
      } else if (!publishFlag) {
        console.log('💡 Run with --publish to also create the version as a private build.')
      }
    } else {
      const text = await response.text()
      console.error(`❌ Upload rejected (HTTP ${response.status}):`, text)
      process.exit(1)
    }
  } catch (err) {
    console.error('❌ Request failed:', err.message)
    process.exit(1)
  }
}

// ── Latest .ehpk discovery ────────────────────────────────
function findEhpk() {
  const version = readAppVersion()
  const expected = join(repoRoot, `agent-home-${version}.ehpk`)
  if (existsSync(expected)) return expected
  return null
}

// ── Build + pack ──────────────────────────────────────────
function buildAndPack() {
  console.log('🔨 Building frontend...')
  execSync('npm run build:tailscale --prefix web', {
    cwd: repoRoot,
    stdio: 'inherit',
  })

  const version = readAppVersion()
  const output = `agent-home-${version}.ehpk`
  console.log(`📦 Packing ${output}...`)
  execSync(
    `npx --yes @evenrealities/evenhub-cli pack app.json web/dist -o ${output}`,
    { cwd: repoRoot, stdio: 'inherit' }
  )
  return join(repoRoot, output)
}

// ── Boundary generation (crypto-safe) ─────────────────────
function makeBoundary() {
  return '----EvenHubUpload' + randomBytes(16).toString('hex')
}

uploadPackage()

