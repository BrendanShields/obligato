import { describe, expect, it } from "bun:test";
import { openDb } from "@obligato/kernel";
import fc from "fast-check";
import { beginSession, finishSession } from "../../src/session.ts";
import { parseTranscript } from "../../src/transcript.ts";

const tokens = fc.integer({ min: 0, max: 1_000_000 });
const usageArb = fc.record({
  input_tokens: tokens,
  output_tokens: tokens,
  cache_read_input_tokens: tokens,
  cache_creation_input_tokens: tokens,
});

// One step = one unique assistant message id, written as 1..3 JSONL lines
// (one per content block, as Claude Code does). Only the last line's usage
// is authoritative (TEL-1); earlier lines carry decoy usage that a
// line-counting or first-wins parser would mistake for real.
const stepArb = fc.record({
  model: fc.constantFrom("claude-fable-5", "claude-haiku-4-5", "m"),
  usage: usageArb,
  decoyUsages: fc.array(usageArb, { maxLength: 2 }),
});

const noiseArb = fc.constantFrom(
  '{"type":"user","message":{"role":"user","content":"hi"}}',
  '{"type":"summary","summary":"..."}',
  '{"type":"assistant","message":{"id":"msg_nousage","model":"m"}}',
  "not json at all {{{",
  '{"type":"system"}',
  "",
);

// A synthetic transcript: step line-groups (contiguous, as in real
// transcripts) interleaved with arbitrary non-step lines.
const transcriptArb = fc
  .tuple(
    fc.array(stepArb, { minLength: 1, maxLength: 25 }),
    fc.array(noiseArb, { maxLength: 25 }),
    fc.infiniteStream(fc.boolean()),
  )
  .map(([steps, noise, order]) => {
    const groups = steps.map((s, i) =>
      [...s.decoyUsages, s.usage].map((usage) =>
        JSON.stringify({
          type: "assistant",
          message: { id: `msg_${i}`, model: s.model, usage },
        }),
      ),
    );
    const lines: string[] = [];
    const g = [...groups];
    const n = [...noise];
    const pick = order[Symbol.iterator]();
    while (g.length || n.length) {
      const fromGroups = g.length && (!n.length || pick.next().value);
      if (fromGroups) lines.push(...(g.shift() as string[]));
      else lines.push(n.shift() as string);
    }
    return { steps, text: lines.join("\n") };
  });

const PER_CLASS = [
  ["tokens_in", "input_tokens"],
  ["tokens_out", "output_tokens"],
  ["tokens_cache_read", "cache_read_input_tokens"],
  ["tokens_cache_write", "cache_creation_input_tokens"],
] as const;

describe("TEL-1: N unique message ids yield exactly N step records summing per class under the dedup rule", () => {
  it("parseTranscript dedupes by message id (last usage wins), ignoring foreign lines", () => {
    fc.assert(
      fc.property(transcriptArb, ({ steps, text }) => {
        const parsed = parseTranscript(text);
        expect(parsed.length).toBe(steps.length);
        for (const [parsedKey, usageKey] of PER_CLASS)
          expect(parsed.reduce((acc, p) => acc + p[parsedKey], 0)).toBe(
            steps.reduce((acc, s) => acc + s.usage[usageKey], 0),
          );
      }),
      { numRuns: 200 },
    );
  });

  it("real Claude Code shape: multi-line assistant turns are one step each (regression for the 3x over-count)", () => {
    const realShape = [
      // turn 1: text block + tool_use block — same id, identical usage on both lines
      '{"type":"user","message":{"role":"user","content":"do the thing"}}',
      '{"type":"assistant","message":{"id":"msg_01AAA","model":"claude-fable-5","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":7000,"cache_creation_input_tokens":300}}}',
      '{"type":"assistant","message":{"id":"msg_01AAA","model":"claude-fable-5","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":7000,"cache_creation_input_tokens":300}}}',
      '{"type":"user","message":{"role":"user","content":"tool result"}}',
      // turn 2: single block
      '{"type":"assistant","message":{"id":"msg_01BBB","model":"claude-fable-5","usage":{"input_tokens":40,"output_tokens":9,"cache_read_input_tokens":7400,"cache_creation_input_tokens":0}}}',
    ].join("\n");
    const parsed = parseTranscript(realShape);
    expect(parsed.length).toBe(2);
    expect(parsed.map((p) => p.tokens_in)).toEqual([100, 40]);
    expect(parsed.map((p) => p.tokens_out)).toEqual([50, 9]);
    expect(parsed.map((p) => p.tokens_cache_read)).toEqual([7000, 7400]);
  });

  it("session end ingests every deduped step and promotes the session", () => {
    fc.assert(
      fc.property(transcriptArb, ({ steps, text }) => {
        const db = openDb(":memory:");
        const session = beginSession(db, "repo-under-test");
        const result = finishSession(db, session, text);
        expect(result).toEqual({ steps: steps.length, failed: 0 });

        for (const [col, usageKey] of PER_CLASS) {
          const row = db
            .query(
              `SELECT COUNT(*) AS n, COALESCE(SUM(${col}), 0) AS total FROM step_event WHERE session_id = ?`,
            )
            .get(session) as { n: number; total: number };
          expect(row.n).toBe(steps.length);
          expect(row.total).toBe(
            steps.reduce((acc, s) => acc + s.usage[usageKey], 0),
          );
        }
        const status = (
          db.query("SELECT status FROM session WHERE id = ?").get(session) as {
            status: string;
          }
        ).status;
        expect(status).toBe("complete");
        db.close();
      }),
      { numRuns: 50 },
    );
  });

  it("a transcript with no step boundaries yields zero events and still ends the session cleanly", () => {
    const db = openDb(":memory:");
    const session = beginSession(db, "repo-under-test");
    expect(finishSession(db, session, '{"type":"user"}\nnot json\n')).toEqual({
      steps: 0,
      failed: 0,
    });
    const status = (
      db.query("SELECT status FROM session WHERE id = ?").get(session) as {
        status: string;
      }
    ).status;
    expect(status).toBe("complete");
    db.close();
  });
});
