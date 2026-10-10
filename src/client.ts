// Configuration and HTTP client for the DataBazaar MCP server.
// All API calls go through apiCall() which injects auth headers automatically.
//
// Token resolution order:
//   1. DATABAZAAR_API_KEY env var (static API key — existing behavior, unchanged)
//   2. Stored OAuth token from ~/.config/databazaar/token.json
//   3. No auth (runs unauthenticated — discovery tools will still work)

import { loadStoredToken } from './oauth-client.js'

export interface McpConfig {
  apiKey: string
  apiUrl: string
  budgetLimitUsd?: number
  mockMode?: boolean
}

// Reads configuration from environment variables with sensible defaults.
export function getConfig(): McpConfig {
  const mockMode = process.env.DATABAZAAR_MOCK_MODE === 'true'
  const apiUrl = process.env.DATABAZAAR_API_URL ?? 'https://api.databazaar.io'
  const budgetLimitUsd = process.env.DATABAZAAR_BUDGET_LIMIT_USD
    ? Number(process.env.DATABAZAAR_BUDGET_LIMIT_USD)
    : undefined

  // 1. Explicit env var takes highest priority
  if (process.env.DATABAZAAR_API_KEY) {
    return {
      apiKey: process.env.DATABAZAAR_API_KEY,
      apiUrl,
      budgetLimitUsd,
      mockMode,
    }
  }

  // 2. Try stored OAuth token
  const stored = loadStoredToken()
  if (stored?.access_token) {
    return {
      apiKey: stored.access_token,
      // Prefer the API URL from the stored token (in case a different env was used at login)
      apiUrl: stored.api_url ?? apiUrl,
      budgetLimitUsd,
      mockMode,
    }
  }

  // 3. No auth — warn on stderr but allow startup so discovery tools work
  if (!mockMode) {
    process.stderr.write(
      'DataBazaar MCP: Not authenticated.\n' +
      '  Run: npx databazaar-mcp auth login\n' +
      '  Or set DATABAZAAR_API_KEY env var.\n\n'
    )
  }

  return { apiKey: '', apiUrl, budgetLimitUsd, mockMode }
}

// Simple fetch wrapper — adds Bearer auth header and throws on non-OK responses.
export async function apiCall<T>(
  config: McpConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // Only include Authorization header if an API key or OAuth token is set
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

// HTTP callers must supply their own credential. Server-local env/config tokens
// belong to the stdio operator and must never be inherited by remote requests.
export function httpRequestConfig(defaults: McpConfig, authorization?: string): McpConfig {
  return { ...defaults, apiKey: authorization?.startsWith('Bearer ') ? authorization.slice(7) : '' }
}
