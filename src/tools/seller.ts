import { z } from 'zod'
import type { McpConfig } from '../client.js'
import { apiCall } from '../client.js'
import type { ToolDef } from '../tool-helpers.js'

// Pricing fields shared by create/update. All three are forwarded verbatim —
// the API owns normalization (price_cents → price, conflict detection) so the
// MCP layer never silently drops or reinterprets a seller's paid intent.
const pricingFields = {
  pricing_type: z
    .enum(['free', 'buy_it_now', 'auction', 'hybrid'])
    .optional()
    .describe('Pricing model. Inferred as buy_it_now when a positive price is given; defaults to free only when no price is supplied.'),
  price: z.number().optional().describe('Price in USD (e.g. 19). Mutually exclusive with price_cents.'),
  price_cents: z
    .number()
    .int()
    .optional()
    .describe('Price in integer cents (e.g. 1900 = $19.00). Mutually exclusive with price.'),
}

// Kept in the standalone MCP package so published npm clients need no workspace dependency.
const LISTING_TERMS_VERSION = '2026-10-09'
const documentationFields = {
  license: z.string().max(200).nullable().optional().describe('Optional custom reuse terms/license name. If this and license_url are blank, accepted listing terms grant Open Use.'),
  documentation: z.object({
    source_name: z.string().max(2000).optional().describe('Original source or creator name; required before publishing'),
    source_url: z.string().max(2000).optional(),
    license_url: z.string().max(2000).optional().describe('Optional public HTTPS page containing custom reuse terms'),
    collection_method: z.string().max(2000).optional(),
    coverage_status: z.enum(['date_range', 'not_applicable']).optional(),
    coverage_start: z.string().max(100).optional(),
    coverage_end: z.string().max(100).optional(),
    last_updated: z.string().max(100).optional(),
    update_frequency: z.string().max(200).optional().describe('Optional update policy: fixed snapshot, scheduled updates, or occasional updates; say whether future versions are included'),
    notes: z.string().max(2000).optional(),
  }).optional(),
}
const termsAcceptanceFields = {
  tos_confirmed: z.literal(true).describe('Confirm authorization to accept https://databazaar.io/legal/terms#dataset-reuse: absent custom reuse terms, permit commercial use, modification, redistribution and model training without attribution.'),
  listing_terms_version: z.literal(LISTING_TERMS_VERSION).describe('Version of listing terms explicitly accepted by the supplier'),
}

const DRAFT_STATUSES = new Set(['draft', 'pending_verification'])
const ACTIVE_STATUSES = new Set(['active'])

// Resolve which PATCH route applies to a listing by reading its real status.
// Draft rows are edited via /listings/draft/:id (file paths allowed); active
// rows via /listings/:id (metadata + pricing only). Anything else is not
// editable and gets an actionable error instead of a misleading 404.
//
// GET /listings/:id is scoped to THIS agent token, while PATCH /listings/:id
// is scoped to the owner account. A listing created by the human seller UI
// or by another of the owner's agent tokens is therefore invisible to the
// GET but still editable — so a 404 here falls through to the active route
// and lets the API give the authoritative answer.
async function resolveUpdatePath(config: McpConfig, datasetId: string): Promise<string> {
  let listing: { status?: string } | null = null
  try {
    listing = await apiCall<{ status?: string }>(config, 'GET', `/listings/${datasetId}`)
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return `/listings/${datasetId}`
    }
    throw err
  }
  const status = listing?.status ?? 'unknown'
  if (DRAFT_STATUSES.has(status)) return `/listings/draft/${datasetId}`
  if (ACTIVE_STATUSES.has(status)) return `/listings/${datasetId}`
  throw new Error(
    `Listing ${datasetId} has status "${status}" and cannot be updated. ` +
      'Only draft, pending_verification and active listings are editable.'
  )
}

export const sellerTools = (config: McpConfig): Record<string, ToolDef> => ({
  // ── create_listing ─────────────────────────────────────────────────────────
  create_listing: {
    title: 'Create draft listing',
    safety: 'destructive',
    description:
      'Create a new draft dataset listing on DataBazaar and return its dataset_id. ' +
      'Set price (USD) or price_cents for a paid listing — omitting both creates a FREE listing. ' +
      'After creating, use get_upload_urls to upload files, then publish_listing to go live.',
    inputSchema: z.object({
      title: z.string().min(1).max(200).describe('Dataset title'),
      description: z.string().min(1).max(5000).describe('Dataset description'),
      category: z
        .string()
        .optional()
        .describe(
          'Category: geographic, pricing, sensor, images, text, financial, scientific, social, retail, other'
        ),
      tags: z.array(z.string()).optional().describe('Keyword tags for discoverability'),
      ...pricingFields,
      ...documentationFields,
      auction_config: z
        .object({
          start_price: z.number().describe('Starting bid price in USD'),
          reserve_price: z.number().optional().describe('Minimum acceptable sale price'),
          duration_hours: z.number().describe('Auction duration in hours'),
        })
        .optional()
        .describe('Required for auction or hybrid pricing'),
      schema: z
        .record(z.unknown())
        .optional()
        .describe('Data schema describing columns/fields. Set { "format": "zip" } when uploading an archive.'),
    }),
    handler: async (params: {
      title: string
      description: string
      category?: string
      tags?: string[]
      pricing_type?: string
      price?: number
      price_cents?: number
      auction_config?: { start_price: number; reserve_price?: number; duration_hours: number }
      schema?: Record<string, unknown>
      license?: string | null
      documentation?: Record<string, unknown>
      tos_confirmed?: boolean
      listing_terms_version?: string
    }) => {
      return apiCall(config, 'POST', '/listings/draft', params)
    },
  },

  // ── get_upload_urls ────────────────────────────────────────────────────────
  // Provisions signed Supabase upload URLs (storage side effect).
  get_upload_urls: {
    title: 'Get upload URLs',
    safety: 'destructive',
    description:
      'Provision signed upload URLs for a draft listing. Returns URLs for the sample and full dataset files. ' +
      'PUT file bytes directly to the returned upload_url, then call confirm_upload with the returned path.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The draft dataset ID'),
    }),
    handler: async (params: { dataset_id: string }) => {
      return apiCall(config, 'POST', `/listings/${params.dataset_id}/upload-urls`)
    },
  },

  // ── confirm_upload ─────────────────────────────────────────────────────────
  // Draft-only by design: the original file of a published listing is never
  // replaced through this tool.
  confirm_upload: {
    title: 'Confirm dataset upload',
    safety: 'destructive',
    description:
      'Confirm a file has been uploaded to its signed URL and trigger automatic sample generation (drafts only). ' +
      'Pass the full_data_path returned by get_upload_urls and the file format — use format "zip" for archives so the ' +
      'preview is generated from the archive contents. Poll get_listing_status until the sample is ready before publishing.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The draft dataset ID'),
      full_data_path: z
        .string()
        .describe('The storage path from get_upload_urls (e.g. "{ownerId}/{datasetId}/full")'),
      format: z
        .enum(['csv', 'tsv', 'json', 'jsonl', 'geojson', 'parquet', 'xlsx', 'zip', 'pdf', 'docx'])
        .optional()
        .describe('Format of the uploaded file. Strongly recommended — the upload path has no extension.'),
    }),
    handler: async (params: { dataset_id: string; full_data_path: string; format?: string }) => {
      return apiCall(config, 'PATCH', `/listings/draft/${params.dataset_id}`, {
        full_data_path: params.full_data_path,
        ...(params.format ? { schema: { format: params.format } } : {}),
      })
    },
  },

  // ── get_listing_status ─────────────────────────────────────────────────────
  // Read-only status poll.
  get_listing_status: {
    title: 'Get listing status',
    safety: 'readOnly',
    description:
      'Get the current status of a listing or draft. Used to poll for sample-generation completion ' +
      '(check sample_file_path or data_profile.auto_sample_status) before publishing.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The dataset ID'),
    }),
    handler: async (params: { dataset_id: string }) => {
      return apiCall(config, 'GET', `/listings/${params.dataset_id}`)
    },
  },

  // ── update_listing ─────────────────────────────────────────────────────────
  update_listing: {
    title: 'Update listing',
    safety: 'destructive',
    description:
      'Update metadata or pricing on a draft OR active listing. The correct API route is chosen from the ' +
      'listing\'s current status. To change the price of a live listing pass price (USD) or price_cents.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The dataset ID to update'),
      title: z.string().min(1).max(200).optional().describe('New title'),
      description: z.string().min(1).max(5000).optional().describe('New description'),
      category: z.string().optional().describe('New category'),
      tags: z.array(z.string()).optional().describe('New tags'),
      ...pricingFields,
      ...documentationFields,
      schema: z.record(z.unknown()).optional().describe('Updated data schema'),
      tos_confirmed: termsAcceptanceFields.tos_confirmed.optional(),
      listing_terms_version: termsAcceptanceFields.listing_terms_version.optional(),
    }),
    handler: async (params: {
      dataset_id: string
      title?: string
      description?: string
      category?: string
      tags?: string[]
      pricing_type?: string
      price?: number
      price_cents?: number
      schema?: Record<string, unknown>
      license?: string | null
      documentation?: Record<string, unknown>
      tos_confirmed?: boolean
      listing_terms_version?: string
    }) => {
      const { dataset_id, ...body } = params
      const path = await resolveUpdatePath(config, dataset_id)
      return apiCall(config, 'PATCH', path, body)
    },
  },

  // ── set_schema ─────────────────────────────────────────────────────────────
  set_schema: {
    title: 'Set listing schema',
    safety: 'destructive',
    description:
      'Set or update the data schema for a draft or active listing. ' +
      'Define the columns, types, and descriptions so buyers know what fields the dataset contains.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The dataset ID'),
      schema: z
        .record(z.unknown())
        .describe(
          'Schema object describing columns/fields. Example: { "columns": [{ "name": "id", "type": "integer" }, { "name": "email", "type": "string" }] }'
        ),
    }),
    handler: async (params: { dataset_id: string; schema: Record<string, unknown> }) => {
      const path = await resolveUpdatePath(config, params.dataset_id)
      return apiCall(config, 'PATCH', path, { schema: params.schema })
    },
  },

  // ── publish_listing ────────────────────────────────────────────────────────
  publish_listing: {
    title: 'Publish listing',
    safety: 'destructive',
    description:
      'Publish a draft listing to the marketplace. ' +
      'Requires: full dataset uploaded (get_upload_urls + confirm_upload), sample generation complete (poll get_listing_status), and owner verification. ' +
      'Requires documentation.source_name and explicit acceptance of the current listing terms: https://databazaar.io/legal/terms#dataset-reuse. Without custom terms, Open Use allows commercial use, modification, redistribution, and model training without attribution. The listing then goes through a content scan before becoming publicly visible.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The draft dataset ID to publish'),
      ...termsAcceptanceFields,
    }),
    handler: async (params: { dataset_id: string; tos_confirmed: true; listing_terms_version: string }) => {
      return apiCall(config, 'POST', `/listings/${params.dataset_id}/publish`, { tos_confirmed: params.tos_confirmed, listing_terms_version: params.listing_terms_version })
    },
  },
})
