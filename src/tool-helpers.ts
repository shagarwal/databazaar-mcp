// Shared helpers for declaring MCP tools with the metadata required by the
// Anthropic Connectors Directory: a human-readable `title`, exactly one of
// `readOnlyHint` / `destructiveHint`, and a JSON-Schema-shaped `inputSchema`.
//
// Each tool exports a ToolDef. Both transport entry points (stdio + HTTP)
// read the same shape, so annotations are emitted consistently.
import type { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

// Safety classification per Anthropic's review checklist.
//   readOnly:    pure GETs / lookups / no side effects
//   destructive: writes / deletes / payments / messages / publishes
export type Safety = 'readOnly' | 'destructive'

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  // Human-readable name (≤64 chars). Surfaces in connector UI.
  title: string
  // Long description shown to the model.
  description: string
  // Zod schema for the input. Converted to JSON Schema at list-tools time.
  inputSchema: S
  // Safety classification — directly maps to readOnlyHint / destructiveHint.
  safety: Safety
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (params: any) => Promise<unknown>
}

// Build the annotation block consumed by MCP clients (Claude.ai, Desktop, etc.)
// per the connectors-directory review criteria.
export function buildAnnotations(tool: ToolDef): {
  title: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
} {
  return {
    title: tool.title,
    ...(tool.safety === 'readOnly'
      ? { readOnlyHint: true }
      : { destructiveHint: true }),
  }
}

// Convert a tool's Zod schema to a JSON Schema object suitable for an
// MCP `tools/list` response. We strip the `$schema` and `$ref` fields the
// converter adds, since MCP wants a single inline object.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toJsonSchema(schema: z.ZodTypeAny): any {
  const json = zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<string, unknown>
  // zod-to-json-schema emits {$schema, ...rest}; the MCP spec wants just the object.
  delete json.$schema
  if (!json.type) json.type = 'object'
  return json
}
