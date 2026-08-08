// Purchase tools: agents authorize dataset purchases on the DataBazaar
// marketplace. Funds move via Stripe Checkout / Stripe Connect — DataBazaar
// is a marketplace operator, not a payments network. No cryptocurrency, no
// asset transfers; every charge is a card payment to a registered seller.
// Budget enforcement happens client-side before the API call.
import { z } from 'zod'
import type { McpConfig } from '../client.js'
import { apiCall } from '../client.js'
import type { ToolDef } from '../tool-helpers.js'

export const purchaseTools = (config: McpConfig): Record<string, ToolDef> => ({
  // ── buy_now ────────────────────────────────────────────────────────────────────
  // Destructive: charges a card via Stripe and creates a purchase record.
  buy_now: {
    title: 'Buy a dataset',
    safety: 'destructive',
    description:
      'Authorize a one-time purchase of a dataset on the DataBazaar marketplace. ' +
      'Free datasets ($0) require no payment method and are immediately accessible. ' +
      'Paid datasets are charged via Stripe Checkout against the operator\'s saved card or a payment_method_id. ' +
      'DataBazaar is a marketplace; funds move through Stripe Connect to the seller and the platform fee is 3%. ' +
      'Call preview_sample first to verify the dataset matches the operator\'s need.',
    inputSchema: z.object({
      dataset_id: z.string().uuid().describe('The dataset ID to purchase'),
      payment_method_id: z.string().optional().describe(
        'Stripe payment method ID (pm_...). Not needed for free ($0) datasets. ' +
        'Optional for paid datasets if a default card is saved for this operator.'
      ),
    }),
    handler: async (params: { dataset_id: string; payment_method_id?: string }) => {
      // Enforce optional client-side budget limit before authorizing the charge.
      if (config.budgetLimitUsd !== undefined) {
        const dataset = await apiCall<{ price: number }>(config, 'GET', `/datasets/${params.dataset_id}`)
        if (dataset.price > 0 && dataset.price > config.budgetLimitUsd) {
          return {
            error: `Dataset price $${dataset.price} exceeds budget limit $${config.budgetLimitUsd}`,
            code: 'BUDGET_EXCEEDED',
          }
        }
      }
      const body = params.payment_method_id ? { payment_method_id: params.payment_method_id } : {}
      return apiCall(config, 'POST', `/datasets/${params.dataset_id}/buy`, body)
    },
  },
})
