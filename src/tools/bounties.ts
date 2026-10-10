import { z } from 'zod'
import { apiCall, type McpConfig } from '../client.js'
import type { ToolDef } from '../tool-helpers.js'
export const bountyTools = (config: McpConfig): Record<string, ToolDef> => ({
  list_bounty_reviews: {
    title: 'List bounty reviews',
    safety: 'readOnly',
    description:
      'List submissions the current verified agent is authorized to review, oldest first, with due dates and payment next actions.',
    inputSchema: z.object({
      filter: z
        .enum([
          'needs_review',
          'changes_requested',
          'payment_action',
          'completed',
          'all',
        ])
        .optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      updated_since: z.string().datetime().optional(),
    }),
    handler: async (p) =>
      apiCall(
        config,
        'GET',
        `/account/bounty-reviews?${new URLSearchParams(
          Object.entries(p)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        )}`,
      ),
  },
  get_bounty_submission: {
    title: 'Inspect bounty submission',
    safety: 'readOnly',
    description:
      'Read an authorized submission, its review version, requirements, feedback, and settlement timeline. Does not expose full unpaid files.',
    inputSchema: z.object({ submission_id: z.string().uuid() }),
    handler: async (p) =>
      apiCall(config, 'GET', `/bounty-submissions/${p.submission_id}`),
  },
  preview_bounty_submission: {
    title: 'Preview bounty submission',
    safety: 'readOnly',
    description:
      'Get a temporary URL for the safe submission sample. Review the requirements and sample before authorizing a purchase.',
    inputSchema: z.object({
      bounty_id: z.string().uuid(),
      submission_id: z.string().uuid(),
    }),
    handler: async (p) =>
      apiCall(
        config,
        'GET',
        `/bounties/${p.bounty_id}/submissions/${p.submission_id}/sample-url`,
      ),
  },
  review_bounty_submission: {
    title: 'Review a bounty submission',
    safety: 'destructive',
    description:
      'Start review, request changes, decline, or extend once. Requires the current review version; a stale version returns a conflict. This tool does not authorize payment.',
    inputSchema: z.object({
      submission_id: z.string().uuid(),
      version: z.number().int().positive(),
      action: z.enum(['start', 'request_fix', 'reject', 'extend']),
      reason: z.string().min(3).max(4000).optional(),
    }),
    handler: async ({ submission_id, ...p }) =>
      apiCall(config, 'POST', `/bounty-submissions/${submission_id}/review`, p),
  },
  accept_bounty_submission: {
    title: 'Authorize a bounty purchase',
    safety: 'destructive',
    description:
      'Explicitly authorize the displayed reward for ONE submission. Multiple winners are allowed unless an optional cap is configured. Seller setup or payment authentication may be required; accepted is true only after funding succeeds. Resume the same submission to continue an existing purchase; never assume selection means payment completed.',
    inputSchema: z.object({
      submission_id: z.string().uuid(),
      version: z.number().int().positive(),
      amount_cents: z.number().int().positive(),
    }),
    handler: async ({ submission_id, ...p }) => {
      if (
        config.budgetLimitUsd !== undefined &&
        p.amount_cents > Math.round(config.budgetLimitUsd * 100)
      )
        return {
          code: 'BUDGET_EXCEEDED',
          error: 'Reward exceeds the configured agent purchase limit.',
        }
      return apiCall(
        config,
        'POST',
        `/bounty-submissions/${submission_id}/review`,
        { ...p, action: 'accept' },
      )
    },
  },
})
