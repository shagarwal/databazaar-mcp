// Tests for the query_dataset MCP tool — verifies it calls the API correctly
// and parses the NDJSON response into a flat row array.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { queryTools } from './query.js'
import type { McpConfig } from '../client.js'

const baseConfig: McpConfig = {
  apiKey: 'dbz_live_test',
  apiUrl: 'http://localhost:3001',
  budgetLimitUsd: undefined,
  mockMode: false,
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('query_dataset', () => {
  it('POSTs to /datasets/:id/query with body and Bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchMock)

    const tools = queryTools(baseConfig)
    await tools.query_dataset.handler({
      dataset_id: '00000000-0000-0000-0000-000000000001',
      where: [{ column: 'lang', op: '=', value: 'en' }],
      limit: 50,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:3001/datasets/00000000-0000-0000-0000-000000000001/query')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer dbz_live_test')
    expect(JSON.parse(init.body)).toEqual({
      select: undefined,
      where: [{ column: 'lang', op: '=', value: 'en' }],
      limit: 50,
    })
  })

  it('parses NDJSON body into rows', async () => {
    const ndjson = '{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n{"id":3,"name":"c"}\n'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => ndjson,
    }))

    const tools = queryTools(baseConfig)
    const result = await tools.query_dataset.handler({
      dataset_id: '00000000-0000-0000-0000-000000000001',
      limit: 100,
    }) as { rows: unknown[]; count: number }

    expect(result.count).toBe(3)
    expect(result.rows).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
    ])
  })

  it('throws with API error message on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid identifier: "bad name"' }),
    }))

    const tools = queryTools(baseConfig)
    await expect(tools.query_dataset.handler({
      dataset_id: '00000000-0000-0000-0000-000000000001',
      where: [{ column: 'bad name', op: '=', value: 1 }],
      limit: 100,
    })).rejects.toThrow('invalid identifier')
  })

  it('omits Authorization header when no apiKey configured', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchMock)

    const tools = queryTools({ ...baseConfig, apiKey: '' })
    await tools.query_dataset.handler({
      dataset_id: '00000000-0000-0000-0000-000000000001',
      limit: 100,
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBeUndefined()
  })
})
