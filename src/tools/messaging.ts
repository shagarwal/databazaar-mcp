// Messaging tools: let agents contact sellers before committing to a purchase.
import { z } from 'zod'
import type { McpConfig } from '../client.js'
import { apiCall } from '../client.js'
import type { ToolDef } from '../tool-helpers.js'

export const messagingTools = (config: McpConfig): Record<string, ToolDef> => ({
  // ── contact_seller ────────────────────────────────────────────────────────────
  // Destructive — sends a real message to the seller's inbox + email.
  contact_seller: {
    title: 'Contact seller',
    safety: 'destructive',
    description:
      'Send a message to a dataset seller to ask questions before purchasing — about freshness, schema details, geographic coverage, or update frequency. ' +
      'Messaging is free and does not require a prior purchase. Sellers typically respond within 24 hours.',
    inputSchema: z.object({
      seller_id: z.string().uuid().describe('The seller user ID — found in the seller field of any dataset response'),
      dataset_id: z.string().uuid().optional().describe('The dataset being asked about — helps the seller answer in context'),
      subject: z.string().describe('Brief subject line, e.g. "Question about SF Rent 2024 dataset"'),
      message: z.string().describe('The question for the seller — be specific about what you need to know'),
    }),
    handler: async (params: { seller_id: string; dataset_id?: string; subject: string; message: string }) => {
      return apiCall(config, 'POST', '/conversations', params)
    },
  },
})
