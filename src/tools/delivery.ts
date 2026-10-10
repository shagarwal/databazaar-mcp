// Delivery tools: retrieve download URLs, purchase history, receipts, findings, and listing suggestions.
import { z } from 'zod'
import type { McpConfig } from '../client.js'
import { apiCall } from '../client.js'
import type { ToolDef } from '../tool-helpers.js'

export const deliveryTools = (config: McpConfig): Record<string, ToolDef> => ({
  // ── get_download_url ──────────────────────────────────────────────────────────
  // Read-only — returns a short-lived signed URL to a previously authorized resource.
  get_download_url: {
    title: 'Get download URL',
    safety: 'readOnly',
    description:
      'Get a signed, time-limited (1 hour) download URL for a dataset the agent already has access to. ' +
      'All full downloads require account authentication. For free ($0) datasets, pass dataset_id; for paid datasets, pass purchase_id from a completed buy_now. ' +
      'URLs expire after 1 hour — call again for a fresh one. When retrieval_url is provided, prefer it for observed delivery and include the same account bearer token only on the DataBazaar API host. A manifest requires choosing files; one file need not be the whole dataset.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().optional().describe(
        'Dataset ID — use this for free ($0) datasets. Account authentication required; no purchase needed.'
      ),
      purchase_id: z.string().uuid().optional().describe(
        'Purchase ID from buy_now — use this for paid datasets.'
      ),
    }),
    handler: async (params: { dataset_id?: string; purchase_id?: string }) => {
      if (params.dataset_id) {
        return apiCall(config, 'GET', `/datasets/${params.dataset_id}/download-url`)
      }
      if (params.purchase_id) {
        return apiCall(config, 'GET', `/purchases/${params.purchase_id}/download-url`)
      }
      return { error: 'Provide either dataset_id (free datasets) or purchase_id (paid datasets).' }
    },
  },

  // ── list_purchases ────────────────────────────────────────────────────────────
  // Read-only spending audit.
  list_purchases: {
    title: 'List purchases',
    safety: 'readOnly',
    description:
      'List datasets purchased by this agent with status, prices, and download availability. ' +
      'Useful for spending audits, deduplicating before buy_now, or building a purchase summary for the operator.',
    inputSchema: z.object({
      status: z.enum(['escrowed', 'released', 'disputed', 'refunded']).optional().describe(
        'Filter by purchase status — omit to see all'
      ),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    handler: async (params: { status?: string; limit: number }) => {
      const searchParams = new URLSearchParams({ limit: params.limit.toString() })
      if (params.status) searchParams.set('status', params.status)
      return apiCall(config, 'GET', `/purchases?${searchParams.toString()}`)
    },
  },

  // ── get_purchase_receipt ──────────────────────────────────────────────────────
  // Read-only cost-benefit receipt.
  get_purchase_receipt: {
    title: 'Get purchase receipt',
    safety: 'readOnly',
    description:
      'Get a cost-benefit receipt for a purchase: price paid, estimated scraping hours saved, and equivalent human-labor cost. ' +
      'The human_summary field is a one-liner suitable for forwarding to the operator (e.g. "$9 spent, ~6h scraping saved").',
    inputSchema: z.object({
      purchase_id: z.string().uuid().describe('The purchase ID to generate a receipt for'),
    }),
    handler: async (params: { purchase_id: string }) => {
      return apiCall(config, 'GET', `/purchases/${params.purchase_id}/receipt`)
    },
  },

  // ── share_finding ─────────────────────────────────────────────────────────────
  // Destructive — creates a publicly shareable finding record.
  share_finding: {
    title: 'Share an analysis finding',
    safety: 'destructive',
    description:
      'Create a shareable finding record derived from analysis of a DataBazaar dataset. ' +
      'Returns a share_url the operator can send to their team. Public findings also help others discover the underlying dataset.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The dataset used to generate this finding'),
      summary: z.string().describe('1-3 sentence summary of what was discovered'),
      public: z.boolean().default(true).describe('Whether to make the finding publicly discoverable (default true)'),
    }),
    handler: async (params: { dataset_id: string; summary: string; public?: boolean }) => {
      return apiCall(config, 'POST', '/findings', params)
    },
  },

  // ── suggest_listing ────────────────────────────────────────────────────────────
  // Destructive — creates a draft listing pending operator approval.
  suggest_listing: {
    title: 'Suggest a new listing',
    safety: 'destructive',
    description:
      'Propose a dataset (e.g. produced as a research byproduct) for listing on DataBazaar. ' +
      'Creates a draft pending approval and returns an approval URL the operator can click to publish. ' +
      'The message_for_user field includes the approval link and suggested price.',
    inputSchema: z.object({
      title: z.string().describe('Dataset title — clear, searchable, e.g. "NYC Parking Violations 2024 (CSV)"'),
      description: z.string().describe('What the dataset contains, its source, format, and time range'),
      category: z.string().describe('Category: geographic, pricing, sensor, images, text, financial, scientific, social, retail, other'),
      sample_data: z.string().describe('First ~20 rows of the dataset as a string (CSV or JSON)'),
      suggested_price_usd: z.number().optional().describe('Suggested listing price in USD — omit to let the operator decide'),
    }),
    handler: async (params: {
      title: string
      description: string
      category: string
      sample_data: string
      suggested_price_usd?: number
    }) => {
      return apiCall(config, 'POST', '/agent/listings/suggest', params)
    },
  },
})
