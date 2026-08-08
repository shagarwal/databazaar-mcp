// packages/mcp/src/oauth-client.ts
//
// OAuth 2.0 client — supports Auth Code + PKCE (browser) and Device Authorization Grant (headless).
// Also handles secure token persistence at ~/.config/databazaar/token.json.
import { randomBytes, createHash } from 'crypto'
import { createServer } from 'http'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir, platform } from 'os'

// ── Types ──────────────────────────────────────────────────────────────────

export interface OAuthMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  device_authorization_endpoint: string
  scopes_supported: string[]
  grant_types_supported: string[]
  code_challenge_methods_supported: string[]
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number | null
  scope: string
}

export interface StoredToken {
  access_token: string
  api_url: string
  stored_at: string
}

// ── Config Dir ─────────────────────────────────────────────────────────────

function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return join(xdg, 'databazaar')
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? homedir(), 'databazaar')
  }
  return join(homedir(), '.config', 'databazaar')
}

function getTokenPath(configDir?: string): string {
  return join(configDir ?? getConfigDir(), 'token.json')
}

// ── Token Storage ──────────────────────────────────────────────────────────

export function loadStoredToken(configDir?: string): StoredToken | null {
  try {
    const tokenPath = getTokenPath(configDir)
    const raw = readFileSync(tokenPath, 'utf-8')
    return JSON.parse(raw) as StoredToken
  } catch {
    return null
  }
}

export function saveToken(token: string, apiUrl: string, configDir?: string): void {
  const dir = configDir ?? getConfigDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tokenPath = getTokenPath(dir)
  const stored: StoredToken = {
    access_token: token,
    api_url: apiUrl,
    stored_at: new Date().toISOString(),
  }
  writeFileSync(tokenPath, JSON.stringify(stored, null, 2), { mode: 0o600 })
}

export function deleteStoredToken(configDir?: string): void {
  try {
    const { unlinkSync } = require('fs')
    unlinkSync(getTokenPath(configDir))
  } catch { /* already gone */ }
}

// ── OAuth Discovery ────────────────────────────────────────────────────────

export async function discoverOAuthMetadata(apiUrl: string): Promise<OAuthMetadata> {
  const res = await fetch(`${apiUrl}/.well-known/oauth-authorization-server`)
  if (!res.ok) throw new Error(`Failed to fetch OAuth metadata: HTTP ${res.status}`)
  return res.json() as Promise<OAuthMetadata>
}

// ── PKCE ──────────────────────────────────────────────────────────────────

export interface PKCEPair {
  verifier: string
  challenge: string
}

export function generatePKCE(): PKCEPair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// ── Interactive Browser Flow (Auth Code + PKCE) ───────────────────────────

export async function interactiveAuthFlow(
  metadata: OAuthMetadata,
  clientId: string
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Start a local HTTP server to receive the redirect
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      res.writeHead(200, { 'Content-Type': 'text/html' })
      if (code) {
        res.end(`<html><body style="font-family:monospace;padding:2rem">
          <h2>DataBazaar MCP</h2>
          <p>✓ Authorization successful. You can close this window and return to your terminal.</p>
        </body></html>`)
      } else {
        res.end(`<html><body style="font-family:monospace;padding:2rem">
          <h2>DataBazaar MCP</h2>
          <p>Authorization ${error ? `failed: ${error}` : 'cancelled'}. You can close this window.</p>
        </body></html>`)
      }
      server.close()

      if (!code) {
        reject(new Error(error ?? 'Authorization cancelled'))
        return
      }

      // Exchange code for token
      const { verifier } = pkce
      try {
        const tokenRes = await fetch(metadata.token_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier,
          }).toString(),
        })
        if (!tokenRes.ok) {
          const err = await tokenRes.json().catch(() => ({})) as { error?: string; error_description?: string }
          reject(new Error(err.error_description ?? err.error ?? `Token exchange failed: HTTP ${tokenRes.status}`))
          return
        }
        const tokenData = await tokenRes.json() as TokenResponse
        resolve(tokenData.access_token)
      } catch (err) {
        reject(err)
      }
    })

    // Listen on a random port
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address() as { port: number }
      const port = address.port
      const redirectUri = `http://127.0.0.1:${port}/callback`

      const pkce = generatePKCE()

      // Build authorization URL
      const authUrl = new URL(metadata.authorization_endpoint)
      authUrl.searchParams.set('client_id', clientId)
      authUrl.searchParams.set('redirect_uri', redirectUri)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('code_challenge', pkce.challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('scope', 'mcp')
      authUrl.searchParams.set('state', randomBytes(8).toString('hex'))

      process.stderr.write(`\nOpening browser for authorization...\n`)
      process.stderr.write(`If the browser does not open, visit:\n  ${authUrl.toString()}\n\n`)

      // Attempt to open the browser
      try {
        // Dynamic import — 'open' is an optional peer dep; if missing, user sees the URL above
        const openModule = await import('open').catch(() => null)
        if (openModule?.default) {
          await openModule.default(authUrl.toString())
        }
      } catch { /* ignore — user will copy-paste the URL */ }

      // Store redirectUri for the callback handler (captured via closure)
      ;(server as unknown as Record<string, unknown>)._redirectUri = redirectUri
      ;(server as unknown as Record<string, unknown>)._pkce = pkce
    })

    // Handle closure variables for the callback
    let redirectUri = ''
    let pkce: PKCEPair = { verifier: '', challenge: '' }

    // Override once we have the port
    server.once('listening', () => {
      const address = server.address() as { port: number }
      const port = address.port
      redirectUri = `http://127.0.0.1:${port}/callback`
      pkce = generatePKCE()

      const authUrl = new URL(metadata.authorization_endpoint)
      authUrl.searchParams.set('client_id', clientId)
      authUrl.searchParams.set('redirect_uri', redirectUri)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('code_challenge', pkce.challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('scope', 'mcp')
      authUrl.searchParams.set('state', randomBytes(8).toString('hex'))

      process.stderr.write(`\nOpening browser for authorization...\n`)
      process.stderr.write(`If the browser does not open, visit:\n  ${authUrl.toString()}\n\n`)

      import('open').then((m) => m.default(authUrl.toString())).catch(() => { /* no-op */ })
    })

    server.on('error', reject)

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('Authorization timed out after 5 minutes'))
    }, 5 * 60 * 1000)

    server.once('close', () => clearTimeout(timeout))
  })
}

// ── Device Authorization Flow (RFC 8628) ──────────────────────────────────

/** Best-effort: open a URL in the user's default browser. Silent on failure. */
function tryOpenBrowser(url: string): void {
  try {
    // Lazy-require to avoid forcing the dep at startup; child_process is built-in.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require('child_process') as typeof import('child_process')
    const p = platform()
    let cmd: string
    let args: string[]
    if (p === 'darwin') {
      cmd = 'open'; args = [url]
    } else if (p === 'win32') {
      cmd = 'cmd'; args = ['/c', 'start', '""', url.replace(/&/g, '^&')]
    } else {
      cmd = 'xdg-open'; args = [url]
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => { /* swallow */ })
    child.unref()
  } catch {
    // Swallow — link is still printed, user can click manually.
  }
}

export interface DeviceAuthResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export async function deviceAuthFlow(
  metadata: OAuthMetadata,
  clientId: string,
  options?: { email?: string }
): Promise<string> {
  // Step 1: Request device + user codes
  const params: Record<string, string> = { client_id: clientId, scope: 'mcp' }
  if (options?.email) params.expected_email = options.email

  const deviceRes = await fetch(metadata.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })

  if (!deviceRes.ok) {
    const err = await deviceRes.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error ?? `Device authorization failed: HTTP ${deviceRes.status}`)
  }

  const deviceData = await deviceRes.json() as DeviceAuthResponse
  const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = deviceData

  // Step 2: Display instructions to the user.
  // Prefer verification_uri_complete (one-click link with code pre-filled) when available;
  // fall back to the bare URL + code for older API versions.
  process.stderr.write(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)
  process.stderr.write(`  DataBazaar MCP — Device Authorization\n`)
  process.stderr.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`)
  if (verification_uri_complete) {
    process.stderr.write(`  Open this link to authorize (code is pre-filled):\n\n`)
    process.stderr.write(`    ${verification_uri_complete}\n\n`)
    process.stderr.write(`  Or visit ${verification_uri} and enter code: ${user_code}\n\n`)
  } else {
    process.stderr.write(`  1. Open: ${verification_uri}\n`)
    process.stderr.write(`  2. Enter code: ${user_code}\n\n`)
  }
  process.stderr.write(`  (expires in ${Math.floor(expires_in / 60)} minutes)\n\n`)

  // Step 2.5: Try to open the link automatically. Best-effort; ignore failures.
  // Skipped when stdout is non-TTY (likely a CI/automation context) or when DATABAZAAR_NO_BROWSER is set.
  if (verification_uri_complete && process.stdout.isTTY && !process.env.DATABAZAAR_NO_BROWSER) {
    tryOpenBrowser(verification_uri_complete)
  }

  // Step 3: Poll until approved or expired
  const pollInterval = (interval ?? 5) * 1000
  const expiry = Date.now() + (expires_in ?? 600) * 1000

  while (Date.now() < expiry) {
    await sleep(pollInterval)

    const tokenRes = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
        client_id: clientId,
      }).toString(),
    })

    if (tokenRes.ok) {
      const tokenData = await tokenRes.json() as TokenResponse
      process.stderr.write(`\n✓ Authorized! Token saved.\n\n`)
      return tokenData.access_token
    }

    const errData = await tokenRes.json().catch(() => ({ error: 'unknown' })) as { error: string }

    if (errData.error === 'authorization_pending') {
      // Normal — keep polling
      continue
    }

    if (errData.error === 'slow_down') {
      // Back off by extra 5s
      await sleep(5000)
      continue
    }

    if (errData.error === 'access_denied') {
      throw new Error('Authorization denied by user')
    }

    if (errData.error === 'expired_token') {
      throw new Error('Device code expired — run `npx databazaar-mcp auth login` again')
    }

    throw new Error(`Unexpected error during device flow: ${errData.error}`)
  }

  throw new Error('Device code expired — run `npx databazaar-mcp auth login` again')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
