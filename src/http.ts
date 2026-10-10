#!/usr/bin/env node
// DataBazaar MCP Server — Streamable HTTP transport entry point.
// Run: databazaar-mcp-http
// Configure: DATABAZAAR_API_KEY, DATABAZAAR_API_URL, DATABAZAAR_MCP_PORT (default 8788),
//            DATABAZAAR_MCP_ALLOWED_ORIGINS (CSV, optional — appended to defaults)
//
// This transport allows hosting the MCP server over HTTP instead of stdio.
// Useful when the MCP server runs as a long-lived service (e.g. Railway, Docker)
// rather than being spawned per-session via npx.
//
// Authentication: accepts a Bearer token in the Authorization header.
// The token can be a dbz_live_ API key OR an OAuth token from `databazaar-mcp auth login`.
//
// Add to your agent framework config:
//   "url": "http://localhost:8788/mcp"  (or your hosted URL)
//
// The stdio transport (databazaar-mcp) keeps working unchanged.
import { SERVER_VERSION } from './version.js'
import { createServer, type IncomingMessage } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getConfig, httpRequestConfig, type McpConfig } from './client.js'
import { discoveryTools } from './tools/discovery.js'
import { bountyTools } from './tools/bounties.js'
import { purchaseTools } from './tools/purchase.js'
import { deliveryTools } from './tools/delivery.js'
import { messagingTools } from './tools/messaging.js'
import { queryTools } from './tools/query.js'
import { sellerTools } from './tools/seller.js'
import { getResources } from './resources.js'
import { buildAnnotations, toJsonSchema } from './tool-helpers.js'
import { capToolResultText } from './result-cap.js'

const DEFAULT_PORT = 8788

// Origin allowlist — required by Streamable HTTP review criteria to prevent
// DNS rebinding from random web origins. Anthropic's first-party clients use
// claude.ai / claude.com / anthropic.com. Local clients (Inspector, Cursor,
// Claude Desktop) typically send loopback origins, which we accept too.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://claude.ai',
  'https://claude.com',
  'https://www.claude.com',
  'https://anthropic.com',
  'https://www.anthropic.com',
]

function buildOriginAllowlist(): { exact: Set<string>; loopback: boolean } {
  const extras = (process.env.DATABAZAAR_MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  return {
    exact: new Set([...DEFAULT_ALLOWED_ORIGINS, ...extras]),
    loopback: true, // accept http://localhost:* and http://127.0.0.1:*
  }
}

function isOriginAllowed(origin: string | undefined, allowlist: ReturnType<typeof buildOriginAllowlist>): boolean {
  // Missing Origin header is OK for non-browser callers (curl, MCP Inspector,
  // server-to-server). Browsers always set it.
  if (!origin) return true
  if (allowlist.exact.has(origin)) return true
  if (allowlist.loopback) {
    try {
      const u = new URL(origin)
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1') return true
    } catch { /* invalid origin URL */ }
  }
  return false
}

async function main() {
  const defaultConfig = getConfig()
  const port = process.env.DATABAZAAR_MCP_PORT
    ? parseInt(process.env.DATABAZAAR_MCP_PORT, 10)
    : DEFAULT_PORT
  const originAllowlist = buildOriginAllowlist()

  // Each HTTP request gets its own MCP server + transport instance.
  // This is the stateless pattern recommended for Streamable HTTP.
  const httpServer = createServer(async (req, res) => {
    // Health check endpoint — useful for Railway/Docker probes
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', transport: 'streamable-http', port }))
      return
    }

    if (req.url !== '/mcp' || !req.method) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is POST /mcp' }))
      return
    }

    // Origin validation — rejects browser-driven cross-origin requests not in
    // the allowlist. Required by the connector review criteria to prevent
    // DNS rebinding attacks.
    const origin = req.headers['origin']
    if (!isOriginAllowed(typeof origin === 'string' ? origin : undefined, originAllowlist)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden_origin', error_description: `Origin ${origin} is not allowed` }))
      return
    }

    const config = httpRequestConfig(defaultConfig, req.headers.authorization)

    const allTools = {
      ...discoveryTools(config),
      ...purchaseTools(config),
    ...bountyTools(config),
      ...deliveryTools(config),
      ...messagingTools(config),
      ...sellerTools(config),
      ...queryTools(config),
    }

    const resources = getResources(config)

    const server = new Server(
      { name: 'databazaar', version: SERVER_VERSION },
      { capabilities: { tools: {}, resources: {} } }
    )

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.entries(allTools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: toJsonSchema(tool.inputSchema),
        annotations: buildAnnotations(tool),
      })),
    }))

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
      if (!resource) throw new Error(`Unknown resource: ${request.params.uri}`)
      const data = await resource.handler()
      return {
        contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: capToolResultText(JSON.stringify(data, null, 2)) }],
      }
    })

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined
      await server.connect(transport)
      res.on('close', () => { void server.close().catch(() => {}) })
      await transport.handleRequest(req, res, body)
    } catch (error) {
      if (!res.headersSent) res.writeHead((error as { statusCode?: number }).statusCode ?? 400, { 'Content-Type':'application/json' })
      res.end(JSON.stringify({ error:'Invalid MCP request' }))
      await server.close().catch(() => {})
    }
  })

  httpServer.listen(port, process.env.DATABAZAAR_MCP_HOST ?? '127.0.0.1', () => {
    console.error(`DataBazaar MCP server running (streamable HTTP) on port ${port}`)
    console.error(`MCP endpoint: http://localhost:${port}/mcp`)
    console.error(`Health check: http://localhost:${port}/health`)
  })
}

// Bound the body before parsing; the SDK expects a parsed JSON-RPC message.
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw Object.assign(new Error('Body too large'), { statusCode:413 })
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

main().catch(console.error)
