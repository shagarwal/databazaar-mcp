import { describe, expect, it, vi } from 'vitest'
vi.mock('../client.js', () => ({
  apiCall: vi.fn(async () => ({ accepted: false, state: 'awaiting_setup' })),
}))
import { apiCall } from '../client.js'
import { bountyTools } from './bounties.js'
const config = { apiKey: 'test', apiUrl: 'https://example.test' }
describe('bounty MCP tools', () => {
  it('marks purchase authorization destructive and sends an explicit confirmed amount', async () => {
    const t = bountyTools(config).accept_bounty_submission
    expect(t.safety).toBe('destructive')
    await t.handler({ submission_id: 'sub_1', version: 2, amount_cents: 50000 })
    expect(apiCall).toHaveBeenCalledWith(
      config,
      'POST',
      '/bounty-submissions/sub_1/review',
      { action: 'accept', version: 2, amount_cents: 50000 },
    )
  })
  it('respects a client-side agent purchase cap before authorizing', async () => {
    vi.mocked(apiCall).mockClear()
    const r = await bountyTools({
      ...config,
      budgetLimitUsd: 100,
    }).accept_bounty_submission.handler({
      submission_id: 'sub_1',
      version: 1,
      amount_cents: 50000,
    })
    expect(r).toMatchObject({ code: 'BUDGET_EXCEEDED' })
    expect(apiCall).not.toHaveBeenCalled()
  })
  it('keeps nonfinancial review separate from purchase authorization', () => {
    const tools = bountyTools(config)
    expect(
      tools.review_bounty_submission.inputSchema.safeParse({
        submission_id: '00000000-0000-4000-8000-000000000001',
        version: 1,
        action: 'accept',
      }).success,
    ).toBe(false)
    expect(tools.list_bounty_reviews.safety).toBe('readOnly')
  })
})
