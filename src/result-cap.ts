// Tool-result size cap. Claude.ai/Desktop reject tool responses larger than
// ~150,000 characters. We truncate well below that and leave a clear marker
// so the model knows the result was clipped.
const MAX_TOOL_RESULT_CHARS = 140_000

export function capToolResultText(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text
  const trimmed = text.slice(0, MAX_TOOL_RESULT_CHARS)
  const dropped = text.length - MAX_TOOL_RESULT_CHARS
  return `${trimmed}\n\n... [truncated ${dropped} chars; refine your filters or use query_dataset with a tighter limit] ...`
}
