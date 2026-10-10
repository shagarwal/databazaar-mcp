import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Match directory evaluation: start the container without credentials and
// inspect its protocol surface. This makes no marketplace API calls.
const image = process.argv[2]
assert.ok(image, 'Usage: node scripts/check-container.mjs IMAGE')
const transport = new StdioClientTransport({
  command: 'docker',
  args: ['run', '--rm', '-i', '--network=none', image],
  stderr: 'inherit',
})
const client = new Client({ name: 'databazaar-container-check', version: '1.0.0' })
const timeout = setTimeout(() => {
  console.error('Container introspection timed out')
  process.exitCode = 1
  void transport.close()
}, 30_000)
try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  const names = new Set(tools.map(tool => tool.name))
  for (const name of ['search_datasets', 'preview_sample', 'get_download_url']) {
    assert.ok(names.has(name), `Missing expected tool: ${name}`)
  }
  const { resources } = await client.listResources()
  assert.ok(resources.length > 0, 'Expected MCP resources')
  console.log(JSON.stringify({
    server: client.getServerVersion(),
    tools: tools.length,
    resources: resources.length,
    credentials: 'none',
    network: 'disabled',
  }))
} finally {
  clearTimeout(timeout)
  await client.close()
}
