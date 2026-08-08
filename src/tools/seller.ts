import { z } from 'zod'
import type { McpConfig } from '../client.js'
import { apiCall } from '../client.js'
import type { ToolDef } from '../tool-helpers.js'

export const sellerTools = (config: McpConfig): Record<string, ToolDef> => ({
  // ── create_listing ─────────────────────────────────────────────────────────
  create_listing: {
    title: 'Create draft listing',
    safety: 'destructive',
    description:
      'Create a new draft dataset listing on DataBazaar and return its dataset_id. ' +
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
      pricing_type: z
        .enum(['free', 'buy_it_now', 'auction', 'hybrid'])
        .optional()
        .describe('Pricing model (default: free)'),
      price: z.number().optional().describe('Price in USD (required for buy_it_now)'),
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
        .describe('Data schema describing columns/fields'),
    }),
    handler: async (params: {
      title: string
      description: string
      category?: string
      tags?: string[]
      pricing_type?: string
      price?: number
      auction_config?: { start_price: number; reserve_price?: number; duration_hours: number }
      schema?: Record<string, unknown>
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
  confirm_upload: {
    title: 'Confirm dataset upload',
    safety: 'destructive',
    description:
      'Confirm a file has been uploaded to its signed URL and trigger automatic sample generation. ' +
      'Pass the full_data_path returned by get_upload_urls. Poll get_listing_status until the sample is ready before publishing.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The draft dataset ID'),
      full_data_path: z
        .string()
        .describe('The storage path from get_upload_urls (e.g. "{ownerId}/{datasetId}/full")'),
    }),
    handler: async (params: { dataset_id: string; full_data_path: string }) => {
      return apiCall(config, 'PATCH', `/listings/draft/${params.dataset_id}`, {
        full_data_path: params.full_data_path,
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
    description: 'Update metadata on a draft or active listing.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The dataset ID to update'),
      title: z.string().min(1).max(200).optional().describe('New title'),
      description: z.string().min(1).max(5000).optional().describe('New description'),
      category: z.string().optional().describe('New category'),
      tags: z.array(z.string()).optional().describe('New tags'),
      pricing_type: z.enum(['free', 'buy_it_now', 'auction', 'hybrid']).optional(),
      price: z.number().optional().describe('New price in USD'),
      schema: z.record(z.unknown()).optional().describe('Updated data schema'),
    }),
    handler: async (params: {
      dataset_id: string
      title?: string
      description?: string
      category?: string
      tags?: string[]
      pricing_type?: string
      price?: number
      schema?: Record<string, unknown>
    }) => {
      const { dataset_id, ...body } = params
      return apiCall(config, 'PATCH', `/listings/draft/${dataset_id}`, body)
    },
  },

  // ── set_schema ─────────────────────────────────────────────────────────────
  set_schema: {
    title: 'Set listing schema',
    safety: 'destructive',
    description:
      'Set or update the data schema for a draft listing. ' +
      'Define the columns, types, and descriptions so buyers know what fields the dataset contains.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The draft dataset ID'),
      schema: z
        .record(z.unknown())
        .describe(
          'Schema object describing columns/fields. Example: { "columns": [{ "name": "id", "type": "integer" }, { "name": "email", "type": "string" }] }'
        ),
    }),
    handler: async (params: { dataset_id: string; schema: Record<string, unknown> }) => {
      return apiCall(config, 'PATCH', `/listings/draft/${params.dataset_id}`, {
        schema: params.schema,
      })
    },
  },

  // ── publish_listing ────────────────────────────────────────────────────────
  publish_listing: {
    title: 'Publish listing',
    safety: 'destructive',
    description:
      'Publish a draft listing to the marketplace. ' +
      'Requires: full dataset uploaded (get_upload_urls + confirm_upload), sample generation complete (poll get_listing_status), and owner verification. ' +
      'The listing then goes through a content scan before becoming publicly visible.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The draft dataset ID to publish'),
    }),
    handler: async (params: { dataset_id: string }) => {
      return apiCall(config, 'POST', `/listings/${params.dataset_id}/publish`)
    },
  },
})
