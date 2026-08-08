// Tests for the MCP OAuth client utilities.
// Covers: PKCE generation, token storage/loading, and mocked device flow.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash, randomBytes } from 'crypto'
import { existsSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Import functions under test
import {
  generatePKCE,
  loadStoredToken,
  saveToken,
  deleteStoredToken,
  discoverOAuthMetadata,
  deviceAuthFlow,
} from './oauth-client.js'

// ---------------------------------------------------------------------------
// PKCE generation
// ---------------------------------------------------------------------------

describe('generatePKCE', () => {
  it('produces a verifier and a base64url-encoded S256 challenge', () => {
    const { verifier, challenge } = generatePKCE()
    expect(verifier).toBeTruthy()
    expect(challenge).toBeTruthy()

    // Recompute and verify
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
  })

  it('generates different verifiers each call', () => {
    const a = generatePKCE()
    const b = generatePKCE()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).not.toBe(b.challenge)
  })

  it('verifier has at least 43 characters (OAuth minimum)', () => {
    const { verifier } = generatePKCE()
    // randomBytes(32).toString('base64url') = 43 chars
    expect(verifier.length).toBeGreaterThanOrEqual(43)
  })

  it('challenge contains only base64url-safe characters', () => {
    const { challenge } = generatePKCE()
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+=*$/)
  })
})

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

describe('Token storage', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'databazaar-test-'))
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
  })

  it('saveToken writes a file; loadStoredToken reads it back', () => {
    const token = randomBytes(32).toString('hex')
    const apiUrl = 'https://api.databazaar.io'

    saveToken(token, apiUrl, tmpDir)
    const loaded = loadStoredToken(tmpDir)

    expect(loaded).not.toBeNull()
    expect(loaded!.access_token).toBe(token)
    expect(loaded!.api_url).toBe(apiUrl)
    expect(loaded!.stored_at).toBeTruthy()
  })

  it('loadStoredToken returns null when no file exists', () => {
    const empty = loadStoredToken(join(tmpDir, 'nonexistent'))
    expect(empty).toBeNull()
  })

  it('deleteStoredToken removes the token file', () => {
    saveToken('tok', 'https://api.databazaar.io', tmpDir)
    expect(loadStoredToken(tmpDir)).not.toBeNull()
    deleteStoredToken(tmpDir)
    expect(loadStoredToken(tmpDir)).toBeNull()
  })

  it('deleteStoredToken does not throw when file is already gone', () => {
    expect(() => deleteStoredToken(join(tmpDir, 'ghost'))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// discoverOAuthMetadata (mocked fetch)
// ---------------------------------------------------------------------------

describe('discoverOAuthMetadata', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('fetches and returns the metadata object', async () => {
    const mockMetadata = {
      issuer: 'https://api.databazaar.io',
      authorization_endpoint: 'https://api.databazaar.io/oauth/authorize',
      token_endpoint: 'https://api.databazaar.io/oauth/token',
      device_authorization_endpoint: 'https://api.databazaar.io/oauth/device',
      scopes_supported: ['mcp'],
      grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'],
      code_challenge_methods_supported: ['S256'],
    }

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockMetadata),
    } as Response)

    const metadata = await discoverOAuthMetadata('https://api.databazaar.io')
    expect(metadata.issuer).toBe('https://api.databazaar.io')
    expect(metadata.grant_types_supported).toContain('authorization_code')
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.databazaar.io/.well-known/oauth-authorization-server'
    )
  })

  it('throws on non-OK response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response)
    await expect(discoverOAuthMetadata('https://api.databazaar.io')).rejects.toThrow('Failed to fetch OAuth metadata')
  })
})

// ---------------------------------------------------------------------------
// deviceAuthFlow (mocked fetch — full polling loop)
// ---------------------------------------------------------------------------

describe('deviceAuthFlow', () => {
  const originalFetch = global.fetch
  const originalStderr = process.stderr.write.bind(process.stderr)

  beforeEach(() => {
    // Silence stderr output during tests
    process.stderr.write = vi.fn() as typeof process.stderr.write
  })

  afterEach(() => {
    global.fetch = originalFetch
    process.stderr.write = originalStderr
  })

  const mockMetadata = {
    issuer: 'https://api.databazaar.io',
    authorization_endpoint: 'https://api.databazaar.io/oauth/authorize',
    token_endpoint: 'https://api.databazaar.io/oauth/token',
    device_authorization_endpoint: 'https://api.databazaar.io/oauth/device',
    scopes_supported: ['mcp'],
    grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'],
    code_challenge_methods_supported: ['S256'],
  }

  it('succeeds after one authorization_pending + one approved poll', async () => {
    let callCount = 0

    global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      const body = opts?.body?.toString() ?? ''

      // Device authorization request
      if (url.includes('/oauth/device')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            device_code: 'test-dc',
            user_code: 'ABCD-1234',
            verification_uri: 'https://databazaar.io/activate',
            verification_uri_complete: 'https://databazaar.io/activate?code=ABCD-1234',
            expires_in: 600,
            interval: 0, // use 0ms interval for tests
          }),
        } as Response)
      }

      // Token polling
      if (url.includes('/oauth/token')) {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ error: 'authorization_pending' }),
          } as Response)
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            access_token: 'final-access-token',
            token_type: 'Bearer',
            expires_in: null,
            scope: 'mcp',
          }),
        } as Response)
      }

      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof global.fetch

    const token = await deviceAuthFlow(mockMetadata, 'databazaar-mcp')
    expect(token).toBe('final-access-token')
    expect(callCount).toBe(2)
  })

  it('throws on access_denied', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/oauth/device')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            device_code: 'dc', user_code: 'ABCD-1234',
            verification_uri: 'https://databazaar.io/activate',
            verification_uri_complete: 'https://databazaar.io/activate?code=ABCD-1234',
            expires_in: 600, interval: 0,
          }),
        } as Response)
      }
      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ error: 'access_denied' }),
      } as Response)
    }) as typeof global.fetch

    await expect(deviceAuthFlow(mockMetadata, 'databazaar-mcp')).rejects.toThrow('denied')
  })
})
