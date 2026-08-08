#!/usr/bin/env node
// DataBazaar MCP Server — stdio entry point
//
// Usage:
//   npx databazaar-mcp                              — start MCP server
//   npx databazaar-mcp auth login                   — authenticate (browser flow)
//   npx databazaar-mcp auth login --device          — authenticate (device flow, headless)
//   npx databazaar-mcp auth login --email foo@x.com — hint which account to authorize
//   npx databazaar-mcp auth logout                  — remove stored token
//   npx databazaar-mcp auth status                  — show auth status
//
// Configure: set DATABAZAAR_API_KEY env var (and optionally DATABAZAAR_API_URL, DATABAZAAR_BUDGET_LIMIT_USD)
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getConfig, apiCall } from './client.js'
import {
  discoverOAuthMetadata,
  interactiveAuthFlow,
  deviceAuthFlow,
  saveToken,
  deleteStoredToken,
  loadStoredToken,
} from './oauth-client.js'
import { discoveryTools } from './tools/discovery.js'
import { purchaseTools } from './tools/purchase.js'
import { deliveryTools } from './tools/delivery.js'
import { messagingTools } from './tools/messaging.js'
import { sellerTools } from './tools/seller.js'
import { queryTools } from './tools/query.js'
import { getResources } from './resources.js'
import { buildAnnotations, toJsonSchema } from './tool-helpers.js'
import { capToolResultText } from './result-cap.js'

const DEFAULT_API_URL = process.env.DATABAZAAR_API_URL ?? 'https://api.databazaar.io'
const CLIENT_ID = 'databazaar-mcp'

// ── Auth subcommands ──────────────────────────────────────────────────────

async function authLogin(deviceMode: boolean, email?: string): Promise<void> {
  process.stderr.write('Fetching OAuth configuration…\n')
  const metadata = await discoverOAuthMetadata(DEFAULT_API_URL)

  let token: string

  const forceDevice = deviceMode
    || process.env.DATABAZAAR_AUTH_MODE === 'device'
    || !process.env.DISPLAY && process.platform !== 'darwin' && process.platform !== 'win32'

  if (forceDevice) {
    token = await deviceAuthFlow(metadata, CLIENT_ID, email ? { email } : undefined)
  } else {
    token = await interactiveAuthFlow(metadata, CLIENT_ID)
  }

  saveToken(token, DEFAULT_API_URL)
  process.stderr.write('Authentication complete. You can now run: npx databazaar-mcp\n')
}

async function authLogout(): Promise<void> {
  deleteStoredToken()
  process.stderr.write('Signed out. Token removed.\n')
}

async function authStatus(): Promise<void> {
  const stored = loadStoredToken()
  if (!stored) {
    process.stderr.write('Not authenticated.\nRun: npx databazaar-mcp auth login\n')
    return
  }

  const apiUrl = stored.api_url ?? DEFAULT_API_URL
  try {
    const identity = await apiCall<{ agent_id: string; display_name: string; operator_id: string }>(
      { apiKey: stored.access_token, apiUrl },
      'GET',
      '/agent/identity'
    )
    process.stderr.write(`Authenticated\n  API:     ${apiUrl}\n  Key ID:  ${identity.agent_id}\n  Name:    ${identity.display_name ?? '(none)'}\n`)
  } catch {
    process.stderr.write(`Token stored but API call failed — token may be revoked.\nStored at: ${new Date(stored.stored_at).toLocaleString()}\n`)
  }
}

// ── Main MCP server ───────────────────────────────────────────────────────

async function startServer(): Promise<void> {
  const config = getConfig()
  const server = new Server(
    { name: 'databazaar', version: '1.2.0' },
    { capabilities: { tools: {}, resources: {} } }
  )

  // Merge all tool categories into a single flat map keyed by tool name
  const allTools = {
    ...discoveryTools(config),
    ...purchaseTools(config),
    ...deliveryTools(config),
    ...messagingTools(config),
    ...sellerTools(config),
    ...queryTools(config),
  }

  const resources = getResources(config)

  // List tools — emits real JSON Schema for inputSchema and the safety/title
  // annotations required by the Anthropic Connectors Directory.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(allTools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: toJsonSchema(tool.inputSchema),
      annotations: buildAnnotations(tool),
    })),
  }))

  // Dispatch tool calls to the appropriate handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = allTools[request.params.name as keyof typeof allTools]
    if (!tool) {
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }], isError: true }
    }
    try {
      const result = await tool.handler(request.params.arguments ?? {})
      return { content: [{ type: 'text' as const, text: capToolResultText(JSON.stringify(result, null, 2)) }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map(r => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })),
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resources.find(r => r.uri === request.params.uri)
    if (!resource) {
      throw new Error(`Unknown resource: ${request.params.uri}`)
    }
    const data = await resource.handler()
    return {
      contents: [{
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: capToolResultText(JSON.stringify(data, null, 2)),
      }],
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('DataBazaar MCP server running (stdio)')
}

// ── CLI entry point ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)

  if (args[0] === 'auth') {
    const subcommand = args[1]
    if (subcommand === 'login') {
      const deviceMode = args.includes('--device')
      const emailIdx = args.indexOf('--email')
      const email = emailIdx !== -1 ? args[emailIdx + 1] : undefined
      await authLogin(deviceMode, email)
      process.exit(0)
    } else if (subcommand === 'logout') {
      await authLogout()
      process.exit(0)
    } else if (subcommand === 'status') {
      await authStatus()
      process.exit(0)
    } else {
      process.stderr.write(
        'Usage:\n' +
        '  npx databazaar-mcp auth login                    # browser OAuth flow\n' +
        '  npx databazaar-mcp auth login --device           # device code flow (headless)\n' +
        '  npx databazaar-mcp auth login --email you@x.com  # hint expected account\n' +
        '  npx databazaar-mcp auth logout                   # remove stored token\n' +
        '  npx databazaar-mcp auth status                   # show auth status\n'
      )
      process.exit(1)
    }
  }

  await startServer()
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`)
  process.exit(1)
})
