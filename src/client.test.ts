import { httpRequestConfig } from './client.js'
// packages/mcp/src/client.test.ts
// Tests for the MCP client: configuration reading and HTTP API calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getConfig, apiCall, type McpConfig } from './client.js'

// ---------------------------------------------------------------------------
// getConfig — reads env vars with sensible defaults
// ---------------------------------------------------------------------------

describe('getConfig', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv }
  })

  it('returns defaults when no env vars are set', () => {
    delete process.env.DATABAZAAR_API_KEY
    delete process.env.DATABAZAAR_API_URL
    delete process.env.DATABAZAAR_BUDGET_LIMIT_USD
    delete process.env.DATABAZAAR_MOCK_MODE

    const config = getConfig()
    expect(config.apiKey).toBe('')
    expect(config.apiUrl).toBe('https://api.databazaar.io')
    expect(config.budgetLimitUsd).toBeUndefined()
    expect(config.mockMode).toBe(false)
  })

  it('reads all env vars when set', () => {
    process.env.DATABAZAAR_API_KEY = 'dbz_live_test_key'
    process.env.DATABAZAAR_API_URL = 'http://localhost:3001'
    process.env.DATABAZAAR_BUDGET_LIMIT_USD = '50'
    process.env.DATABAZAAR_MOCK_MODE = 'true'

    const config = getConfig()
    expect(config.apiKey).toBe('dbz_live_test_key')
    expect(config.apiUrl).toBe('http://localhost:3001')
    expect(config.budgetLimitUsd).toBe(50)
    expect(config.mockMode).toBe(true)
  })

  it('treats non-"true" mock mode as false', () => {
    process.env.DATABAZAAR_MOCK_MODE = 'false'
    expect(getConfig().mockMode).toBe(false)

    process.env.DATABAZAAR_MOCK_MODE = '1'
    expect(getConfig().mockMode).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// apiCall — fetch wrapper with auth and error handling
// ---------------------------------------------------------------------------

describe('apiCall', () => {
  const baseConfig: McpConfig = {
    apiKey: 'dbz_live_test_key',
    apiUrl: 'http://localhost:3001',
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends GET request with auth header and returns parsed JSON', async () => {
    const mockResponse = { data: [{ id: 'ds-1' }] }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response)

    const result = await apiCall(baseConfig, 'GET', '/datasets')

    expect(result).toEqual(mockResponse)
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3001/datasets',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer dbz_live_test_key',
          'Content-Type': 'application/json',
        }),
      })
    )
  })

  it('sends POST request with body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'purchase-1' }),
    } as Response)

    await apiCall(baseConfig, 'POST', '/purchases', { dataset_id: 'ds-1' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3001/purchases',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ dataset_id: 'ds-1' }),
      })
    )
  })

  it('omits Authorization header when no API key is set', async () => {
    const noKeyConfig: McpConfig = { apiKey: '', apiUrl: 'http://localhost:3001' }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    } as Response)

    await apiCall(noKeyConfig, 'GET', '/datasets')

    const callHeaders = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
    expect(callHeaders).not.toHaveProperty('Authorization')
  })

  it('throws on non-OK response with server error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Dataset not found' }),
    } as Response)

    await expect(
      apiCall(baseConfig, 'GET', '/datasets/nonexistent')
    ).rejects.toThrow('Dataset not found')
  })

  it('throws generic HTTP error when response body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
    } as Response)

    await expect(
      apiCall(baseConfig, 'GET', '/datasets')
    ).rejects.toThrow('HTTP 500')
  })
})

describe('HTTP credential isolation', () => {
  it('never inherits the local operator token for anonymous requests', () => {
    expect(httpRequestConfig({apiKey:'operator-secret',apiUrl:'https://api.example.test'}).apiKey).toBe('')
  })
  it('uses only the incoming bearer token', () => {
    expect(httpRequestConfig({apiKey:'operator-secret',apiUrl:'https://api.example.test'},'Bearer caller-token').apiKey).toBe('caller-token')
  })
})
