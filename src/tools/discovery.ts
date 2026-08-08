// Discovery tools: let agents search, browse, preview, and evaluate datasets.
import { z } from 'zod'
import type { McpConfig } from '../client.js'
import { apiCall } from '../client.js'
import type { ToolDef } from '../tool-helpers.js'

export const discoveryTools = (config: McpConfig): Record<string, ToolDef> => ({
  // ── search_datasets ───────────────────────────────────────────────────────────
  // Read-only full-text + faceted search across the marketplace.
  search_datasets: {
    title: 'Search datasets',
    safety: 'readOnly',
    description:
      'Search the DataBazaar marketplace for datasets matching a natural-language query, ' +
      'with optional filters for category, price, quality score, and pricing type. ' +
      'Returns ranked listings with prices, quality scores, and checkout URLs. ' +
      'When results are empty, log_data_gap can post a bounty to signal demand to sellers.',
    inputSchema: z.object({
      query: z.string().describe('Natural language search query describing the data needed'),
      category: z.string().optional().describe(
        'Filter by category: geographic, pricing, sensor, images, text, financial, scientific, social, retail, other'
      ),
      max_price: z.number().optional().describe('Maximum price in USD — omit to include all prices'),
      min_quality_score: z.number().min(0).max(10).optional().describe('Minimum quality score (0-10)'),
      pricing_type: z.enum(['buy_it_now', 'auction', 'hybrid', 'free']).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    handler: async (params: {
      query?: string
      category?: string
      max_price?: number
      min_quality_score?: number
      pricing_type?: string
      limit: number
    }) => {
      const searchParams = new URLSearchParams()
      if (params.query) searchParams.set('query', params.query)
      if (params.category) searchParams.set('category', params.category)
      if (params.max_price !== undefined) searchParams.set('max_price', params.max_price.toString())
      if (params.min_quality_score !== undefined) searchParams.set('min_quality_score', params.min_quality_score.toString())
      if (params.pricing_type) searchParams.set('pricing_type', params.pricing_type)
      searchParams.set('limit', (params.limit ?? 10).toString())
      return apiCall(config, 'GET', `/datasets?${searchParams.toString()}`)
    },
  },

  // ── get_dataset ───────────────────────────────────────────────────────────────
  // Read-only fetch of full dataset metadata.
  get_dataset: {
    title: 'Get dataset detail',
    safety: 'readOnly',
    description:
      'Get full metadata for a specific dataset — schema, column counts, quality score, price anchoring, and a forwardable purchase pitch. ' +
      'Includes a checkout_url for one-click human purchase and a human_pitch field for operator messaging.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The dataset ID to retrieve'),
    }),
    handler: async (params: { dataset_id: string }) => {
      return apiCall(config, 'GET', `/datasets/${params.dataset_id}`)
    },
  },

  // ── preview_sample ─────────────────────────────────────────────────────────────
  // Read-only sample preview, no purchase or auth required.
  preview_sample: {
    title: 'Preview dataset sample',
    safety: 'readOnly',
    description:
      'Preview sample rows of a dataset to verify it contains the expected columns, format, and quality. ' +
      'Returns a signed download URL for ~50 rows plus the schema. ' +
      'Pass an optional question to get a synthesized answer from the sample (e.g. "average price in 2024") — no purchase required.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The dataset ID to preview'),
      question: z.string().optional().describe(
        'Optional natural-language question to answer from the sample (e.g. "average rent in SF", "count of records per state"). ' +
        'Returns a synthesized_answer field with deterministic aggregates if the question matches a simple pattern.'
      ),
    }),
    handler: async (params: { dataset_id: string; question?: string }) => {
      const sp = new URLSearchParams()
      if (params.question) sp.set('question', params.question)
      const qs = sp.toString() ? `?${sp.toString()}` : ''
      return apiCall(config, 'GET', `/datasets/${params.dataset_id}/sample${qs}`)
    },
  },

  // ── find_data_for_task ─────────────────────────────────────────────────────────
  // Read-only task-based recommendation.
  find_data_for_task: {
    title: 'Recommend datasets for a task',
    safety: 'readOnly',
    description:
      'Given a free-text research or analysis task, return DataBazaar datasets ranked by relevance. ' +
      'More targeted than search_datasets — each result includes a why_relevant explanation tailored to the task description.',
    inputSchema: z.object({
      task_description: z.string().describe(
        'Describe the goal — e.g. "train a model to predict apartment rent in SF using 2024 listings"'
      ),
      budget_usd: z.number().optional().describe('Maximum budget in USD — omit to include all price ranges'),
    }),
    handler: async (params: { task_description: string; budget_usd?: number }) => {
      const sp = new URLSearchParams({ task: params.task_description })
      if (params.budget_usd !== undefined) sp.set('budget', params.budget_usd.toString())
      return apiCall(config, 'GET', `/datasets/recommend?${sp.toString()}`)
    },
  },

  // ── log_data_gap ───────────────────────────────────────────────────────────────
  // Write — creates a data-gap record and may auto-create a bounty listing.
  log_data_gap: {
    title: 'Log a data gap',
    safety: 'destructive',
    description:
      'Record an unmet data need on DataBazaar. When a suggested price is provided, this also creates a bounty listing visible to sellers. ' +
      'Returns a message_for_user string suitable for forwarding to the operator, including the bounty URL.',
    inputSchema: z.object({
      query: z.string().describe('The search query or data need that returned no results'),
      description: z.string().describe('Detailed description of the data needed — format, time range, geography, etc.'),
      suggested_price_usd: z.number().optional().describe('Suggested bounty price in USD (default $25 if not provided)'),
    }),
    handler: async (params: { query: string; description: string; suggested_price_usd?: number }) => {
      return apiCall(config, 'POST', '/agent/data-gaps', params)
    },
  },

  // ── check_coverage ─────────────────────────────────────────────────────────────
  // Read-only — does DataBazaar already have this source?
  check_coverage: {
    title: 'Check source coverage',
    safety: 'readOnly',
    description:
      'Check whether a known public data source (e.g. "noaa", "data.gov", "census.gov") is already on DataBazaar. ' +
      'Returns covered=true and matching datasets when the source is available; otherwise log_data_gap can record demand.',
    inputSchema: z.object({
      source_url: z.string().optional().describe(
        'Full URL of the data source (e.g. "https://noaa.gov") — will be normalized'
      ),
      source_name: z.string().optional().describe(
        'Short name of the data source (e.g. "noaa", "census", "data.gov")'
      ),
    }),
    handler: async (params: { source_url?: string; source_name?: string }) => {
      const source = params.source_url ?? params.source_name
      if (!source) return { error: 'Provide either source_url or source_name' }
      const sp = new URLSearchParams({ source })
      return apiCall(config, 'GET', `/coverage?${sp.toString()}`)
    },
  },

  // ── get_related_datasets ───────────────────────────────────────────────────────
  // Read-only similarity lookup.
  get_related_datasets: {
    title: 'Find related datasets',
    safety: 'readOnly',
    description:
      'Given a dataset ID, return similar datasets in the same category ranked by tag overlap. ' +
      'Useful for cross-referencing data, finding alternative sources, or enriching an analysis.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The dataset to find relatives for'),
      limit: z.number().int().min(1).max(20).default(5).describe('Number of related datasets to return (default 5)'),
    }),
    handler: async (params: { dataset_id: string; limit?: number }) => {
      const sp = new URLSearchParams({ limit: (params.limit ?? 5).toString() })
      return apiCall(config, 'GET', `/datasets/${params.dataset_id}/related?${sp.toString()}`)
    },
  },
})
