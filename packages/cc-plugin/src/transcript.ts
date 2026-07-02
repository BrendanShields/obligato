export interface TranscriptStep {
  model: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

interface TranscriptEntry {
  type?: string;
  message?: { id?: string; model?: string; usage?: Record<string, unknown> };
}

const count = (v: unknown): number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;

// TEL-1: a step boundary is a unique assistant message id — Claude Code writes
// one JSONL line per content block, so lines sharing message.id are one step
// and the last-seen usage for that id is authoritative. Foreign or malformed
// lines are skipped, never abort capture (TEL-5 discipline). An id-less
// assistant-usage line counts as its own step.
export const parseTranscript = (jsonl: string): TranscriptStep[] => {
  const steps = new Map<string, TranscriptStep>();
  let anonymous = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry?.message?.usage;
    if (entry?.type !== "assistant" || usage === undefined || usage === null)
      continue;
    const key = entry.message?.id ?? `anonymous-${anonymous++}`;
    steps.set(key, {
      model: entry.message?.model || "unknown",
      tokens_in: count(usage.input_tokens),
      tokens_out: count(usage.output_tokens),
      tokens_cache_read: count(usage.cache_read_input_tokens),
      tokens_cache_write: count(usage.cache_creation_input_tokens),
    });
  }
  return [...steps.values()];
};
