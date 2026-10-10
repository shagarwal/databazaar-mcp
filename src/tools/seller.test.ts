// Tests for seller tools that mutate listings — verifies update/schema calls
// are routed by the listing's real status (draft vs active) instead of always
// hitting the draft-only endpoint, and that pricing input passes through
// untouched so the API's single normalizer can validate it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sellerTools } from './seller.js'
import type { McpConfig } from '../client.js'

const baseConfig: McpConfig = {
  apiKey: 'dbz_live_test',
  apiUrl: 'http://localhost:3001',
  budgetLimitUsd: undefined,
  mockMode: false,
}

const DATASET_ID = '00000000-0000-0000-0000-000000000001'

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('update_listing routing', () => {
  it('PATCHes /listings/draft/:id when the listing is a draft', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: DATASET_ID, status: 'draft' }))
      .mockResolvedValueOnce(jsonResponse({ id: DATASET_ID, status: 'draft', price: 19 }))
    vi.stubGlobal('fetch', fetchMock)

    const tools = sellerTools(baseConfig)
    await tools.update_listing.handler({ dataset_id: DATASET_ID, price_cents: 1900 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe(`http://localhost:3001/listings/${DATASET_ID}`)
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe(`http://localhost:3001/listings/draft/${DATASET_ID}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ price_cents: 1900 })
  })

  it('PATCHes /listings/:id when the listing is active (never the draft route)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: DATASET_ID, status: 'active' }))
      .mockResolvedValueOnce(jsonResponse({ id: DATASET_ID, status: 'active', price: 19 }))
    vi.stubGlobal('fetch', fetchMock)

    const tools = sellerTools(baseConfig)
    await tools.update_listing.handler({
      dataset_id: DATASET_ID,
      pricing_type: 'buy_it_now',
      price: 19,
    })

    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe(`http://localhost:3001/listings/${DATASET_ID}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ pricing_type: 'buy_it_now', price: 19 })
  })

  it('refuses to update a listing in a non-editable status with an actionable error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: DATASET_ID, status: 'cancelled' }))
    vi.stubGlobal('fetch', fetchMock)

    const tools = sellerTools(baseConfig)
    await expect(
      tools.update_listing.handler({ dataset_id: DATASET_ID, title: 'x' })
    ).rejects.toThrow(/cancelled/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls through to the active route when the token-scoped GET returns 404', async () => {
    // A listing created via the seller UI (or another of the owner's tokens)
    // is invisible to GET /listings/:id but still editable via PATCH.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'Listing not found', code: 'NOT_FOUND' }, 404))
      .mockResolvedValueOnce(jsonResponse({ id: DATASET_ID, status: 'active', price: 19 }))
    vi.stubGlobal('fetch', fetchMock)

    const tools = sellerTools(baseConfig)
    await tools.update_listing.handler({ dataset_id: DATASET_ID, price_cents: 1900 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe(`http://localhost:3001/listings/${DATASET_ID}`)
    expect(init.method).toBe('PATCH')
  })

  it('surfaces the API validation error for conflicting pricing without retrying elsewhere', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: DATASET_ID, status: 'active' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'price and price_cents disagree', code: 'PRICING_CONFLICT' }, 400))
    vi.stubGlobal('fetch', fetchMock)

    const tools = sellerTools(baseConfig)
    await expect(
      tools.update_listing.handler({ dataset_id: DATASET_ID, price: 19, price_cents: 2500 })
    ).rejects.toThrow(/disagree/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('set_schema routing', () => {
  it('uses the active-listing route for active listings', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: DATASET_ID, status: 'active' }))
      .mockResolvedValueOnce(jsonResponse({ id: DATASET_ID }))
    vi.stubGlobal('fetch', fetchMock)

    const tools = sellerTools(baseConfig)
    await tools.set_schema.handler({ dataset_id: DATASET_ID, schema: { format: 'zip' } })

    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe(`http://localhost:3001/listings/${DATASET_ID}`)
    expect(JSON.parse(init.body)).toEqual({ schema: { format: 'zip' } })
  })

  it('uses the draft route for drafts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: DATASET_ID, status: 'pending_verification' }))
      .mockResolvedValueOnce(jsonResponse({ id: DATASET_ID }))
    vi.stubGlobal('fetch', fetchMock)

    const tools = sellerTools(baseConfig)
    await tools.set_schema.handler({ dataset_id: DATASET_ID, schema: { format: 'csv' } })

    expect(fetchMock.mock.calls[1][0]).toBe(`http://localhost:3001/listings/draft/${DATASET_ID}`)
  })
})

describe('confirm_upload', () => {
  it('always targets the draft route — original files are never replaced on active listings', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: DATASET_ID }))
    vi.stubGlobal('fetch', fetchMock)

    const tools = sellerTools(baseConfig)
    await tools.confirm_upload.handler({ dataset_id: DATASET_ID, full_data_path: `o/${DATASET_ID}/full`, format: 'zip' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`http://localhost:3001/listings/draft/${DATASET_ID}`)
    expect(JSON.parse(init.body)).toEqual({ full_data_path: `o/${DATASET_ID}/full`, schema: { format: 'zip' } })
  })
})

describe('create_listing pricing passthrough', () => {
  it('forwards price_cents verbatim so the API normalizer sees it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: DATASET_ID, status: 'draft' }, 201))
    vi.stubGlobal('fetch', fetchMock)

    const tools = sellerTools(baseConfig)
    await tools.create_listing.handler({ title: 'T', description: 'D', price_cents: 1900 })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ price_cents: 1900 })
  })
})

describe('listing documentation and explicit terms acceptance', () => {
  it('keeps source, coverage and custom reuse fields through schema parsing and create', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: DATASET_ID }))
    vi.stubGlobal('fetch', fetchMock)
    const tools = sellerTools(baseConfig)
    const body = { title: 'Research Dataset', description: 'Research observations', documentation: { source_name: 'Creator', coverage_status: 'not_applicable' }, license: 'CC-BY-4.0' }
    const parsed = tools.create_listing.inputSchema.parse(body)
    await tools.create_listing.handler(parsed)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(body)
  })
  it('never defaults terms acceptance and forwards the supplier-selected version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: DATASET_ID }))
    vi.stubGlobal('fetch', fetchMock)
    const tool = sellerTools(baseConfig).publish_listing
    expect(tool.inputSchema.safeParse({ dataset_id: DATASET_ID }).success).toBe(false)
    const body = { dataset_id: DATASET_ID, tos_confirmed: true, listing_terms_version: '2026-10-09' }
    await tool.handler(tool.inputSchema.parse(body))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ tos_confirmed: true, listing_terms_version: '2026-10-09' })
  })
})
