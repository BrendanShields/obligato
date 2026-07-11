import type { Database } from "bun:sqlite";
import { Session, type SharedStepEvent, StepEvent } from "@obligato/schemas";
import { stripStepEvent } from "./privacy.ts";

// TEL-6: OFF by default — this module performs network IO only when the
// caller supplies an endpoint (the explicit opt-in TEL-2 requires); nothing
// in the harness calls it ambiently. Attributes are the TEL-3 shared
// projection, so content-stripping is structural, not filtered.
// (TEL-2's static network scan carries a named exemption for this file.)

const hexId = (ulid: string, bytes: number): string =>
  Buffer.from(ulid, "latin1")
    .toString("hex")
    .slice(0, bytes * 2)
    .padEnd(bytes * 2, "0");

const attr = (key: string, value: string | number) => ({
  key,
  value:
    typeof value === "number"
      ? Number.isInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value }
      : { stringValue: value },
});

const stepAttributes = (shared: SharedStepEvent) => [
  attr("obligato.sdlc_step", shared.sdlc_step),
  attr("obligato.model", shared.model),
  attr("obligato.effort", shared.effort),
  attr("obligato.tokens_in", shared.tokens_in),
  attr("obligato.tokens_out", shared.tokens_out),
  attr("obligato.tokens_cache_read", shared.tokens_cache_read),
  attr("obligato.tokens_cache_write", shared.tokens_cache_write),
  // Unknown cost (PROV-3 null) is an absent attribute, not a fake zero.
  ...(shared.cost_micro_usd === null
    ? []
    : [attr("obligato.cost_micro_usd", shared.cost_micro_usd)]),
  attr("obligato.budget_tokens", shared.budget_tokens),
  attr("obligato.overrun", shared.overrun),
];

export interface OtelExportResult {
  traces: number;
  spans: number;
  payload: unknown;
}

// One trace per session, one span per step event, OTLP/HTTP JSON.
export const exportSessionOtel = async (
  db: Database,
  sessionId: string,
  endpoint: string,
): Promise<OtelExportResult> => {
  const sessionRow = db
    .query("SELECT * FROM session WHERE id = ?")
    .get(sessionId) as Record<string, unknown> | null;
  if (!sessionRow) throw new Error(`unknown session: ${sessionId}`);
  const session = Session.parse(sessionRow);
  const steps = (
    db
      .query("SELECT * FROM step_event WHERE session_id = ? ORDER BY rowid")
      .all(sessionId) as Record<string, unknown>[]
  ).map((r) =>
    StepEvent.parse({ ...r, unit_prices: JSON.parse(r.unit_prices as string) }),
  );
  const traceId = hexId(session.id, 16);
  const startNs = `${Date.parse(session.started_at)}000000`;
  const endNs = `${Date.parse(session.ended_at ?? session.started_at)}000000`;
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr("service.name", "obligato"),
            attr("obligato.session_status", session.status),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "obligato" },
            spans: steps.map((step, i) => {
              const shared = stripStepEvent(step);
              return {
                traceId,
                spanId: hexId(step.id, 8),
                name: `obligato.step.${shared.sdlc_step}`,
                kind: 1,
                startTimeUnixNano: startNs,
                endTimeUnixNano: endNs,
                attributes: [
                  ...stepAttributes(shared),
                  attr("obligato.step_index", i),
                ],
              };
            }),
          },
        ],
      },
    ],
  };
  const res = await fetch(`${endpoint.replace(/\/$/, "")}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok)
    throw new Error(`OTLP export failed: ${res.status} ${await res.text()}`);
  return { traces: 1, spans: steps.length, payload };
};
