// Query tools: agent-callable structured queries against a dataset's source
// file. Streams NDJSON from the API and returns parsed rows as a JSON array.
import { z } from 'zod'
import type { McpConfig } from '../client.js'
import type { ToolDef } from '../tool-helpers.js'

const WhereSchema = z.object({
  column: z.string().describe('Column name to filter on (must be a valid SQL identifier — letters/digits/underscores only)'),
  op: z.enum(['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'IN', 'IS NULL', 'IS NOT NULL'])
    .describe('Comparison operator. Use IN with an array value. IS NULL / IS NOT NULL take no value.'),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  ]).optional().describe('Filter value. Required for binary ops; array required for IN; omit for IS [NOT] NULL.'),
})

export const queryTools = (config: McpConfig): Record<string, ToolDef> => ({
  // ── query_dataset ────────────────────────────────────────────────────────────
  // Read-only: streams a filtered subset via DuckDB without delivering the full file.
  query_dataset: {
    title: 'Query dataset rows',
    safety: 'readOnly',
    description:
      'Run a structured filter query against a queryable dataset and return matching rows. ' +
      'Useful for extracting a subset without downloading the full dataset. ' +
      'Returns rows as a JSON array (max 10,000 per call).',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The dataset ID to query'),
      select: z.array(z.string()).optional()
        .describe('Columns to return. Omit to return all columns.'),
      where: z.array(WhereSchema).optional()
        .describe('Filter clauses combined with AND. Maximum 16 clauses per query.'),
      limit: z.number().int().min(1).max(10_000).default(100)
        .describe('Maximum rows to return (capped at 10,000).'),
    }),
    handler: async (params: {
      dataset_id: string
      select?: string[]
      where?: Array<{ column: string; op: string; value?: unknown }>
      limit: number
    }) => {
      const url = `${config.apiUrl}/datasets/${params.dataset_id}/query`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          select: params.select,
          where: params.where,
          limit: params.limit,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      // The API streams NDJSON — collect into rows.
      const text = await res.text()
      const rows = text.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l))
      return { rows, count: rows.length }
    },
  },
})
