// Verifies the connector-directory metadata path: every tool gets a
// `title`, exactly one of readOnlyHint/destructiveHint, and a JSON-Schema
// inputSchema.
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildAnnotations, toJsonSchema, type ToolDef } from './tool-helpers.js'
import { discoveryTools } from './tools/discovery.js'
import { purchaseTools } from './tools/purchase.js'
import { deliveryTools } from './tools/delivery.js'
import { messagingTools } from './tools/messaging.js'
import { sellerTools } from './tools/seller.js'
import { queryTools } from './tools/query.js'

const config = {
  apiKey: 'dbz_live_test',
  apiUrl: 'http://localhost:3001',
  budgetLimitUsd: undefined,
  mockMode: false,
}

const allTools = {
  ...discoveryTools(config),
  ...purchaseTools(config),
  ...deliveryTools(config),
  ...messagingTools(config),
  ...sellerTools(config),
  ...queryTools(config),
}

describe('buildAnnotations', () => {
  it('emits readOnlyHint=true and no destructiveHint for read-only tools', () => {
    const tool: ToolDef = {
      title: 'Read it',
      safety: 'readOnly',
      description: '',
      inputSchema: z.object({}),
      handler: async () => ({}),
    }
    const ann = buildAnnotations(tool)
    expect(ann).toEqual({ title: 'Read it', readOnlyHint: true })
    expect(ann).not.toHaveProperty('destructiveHint')
  })

  it('emits destructiveHint=true and no readOnlyHint for destructive tools', () => {
    const tool: ToolDef = {
      title: 'Write it',
      safety: 'destructive',
      description: '',
      inputSchema: z.object({}),
      handler: async () => ({}),
    }
    const ann = buildAnnotations(tool)
    expect(ann).toEqual({ title: 'Write it', destructiveHint: true })
    expect(ann).not.toHaveProperty('readOnlyHint')
  })
})

describe('toJsonSchema', () => {
  it('strips $schema and emits a JSON-Schema 7 object', () => {
    const schema = z.object({
      dataset_id: z.string().uuid(),
      limit: z.number().int().min(1).max(100).default(10),
    })
    const json = toJsonSchema(schema)
    expect(json.type).toBe('object')
    expect(json).not.toHaveProperty('$schema')
    expect(json.properties).toHaveProperty('dataset_id')
    expect(json.properties).toHaveProperty('limit')
  })
})

describe('every shipped tool', () => {
  for (const [name, tool] of Object.entries(allTools)) {
    it(`${name} has title ≤64 chars, exactly one safety hint, and a valid JSON Schema`, () => {
      expect(tool.title.length).toBeGreaterThan(0)
      expect(tool.title.length).toBeLessThanOrEqual(64)
      expect(['readOnly', 'destructive']).toContain(tool.safety)

      const ann = buildAnnotations(tool)
      const hasRead = 'readOnlyHint' in ann
      const hasDestructive = 'destructiveHint' in ann
      // Exactly one of the two must be set.
      expect(hasRead !== hasDestructive).toBe(true)

      const schema = toJsonSchema(tool.inputSchema)
      expect(schema.type).toBe('object')
    })
  }
})
