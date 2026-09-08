import { existsSync } from "node:fs";
import {
  computeMetrics,
  DEFAULT_DB_PATH,
  exportMetricsOtel,
  openDb,
} from "@obligato/kernel";
import type { MetricsReport } from "@obligato/schemas";
import { fail } from "../agent/common.js";
import { parseArgs } from "../args.js";
import { kvGrid, panel, table } from "../components/render.js";
import { write } from "../components/sink.js";
import { emitJson } from "../output/json.js";

const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(4)}`;
const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;
// UX §7 `31k tok` above a thousand; below it the raw count reads truer than
// a one-decimal k (150 → "0.1k" is a float artifact, not a measurement).
const ktok = (n: number): string =>
  n < 1000 ? `${Math.round(n)} tok` : `${(n / 1000).toFixed(1)}k tok`;

// UX-41: a null rate is `n/a (0 <denominator noun>)` — never 0, 0%, or $0.
const na = (n: number, noun: string): string => `n/a (${n} ${noun})`;

export const renderMetrics = (r: MetricsReport): string => {
  const t = r.tasks;
  const closed = t.accepted + t.corrected + t.abandoned;
  const windowLabel =
    r.window.since === null && r.window.until === null
      ? "all time"
      : `${r.window.since ?? "…"} → ${r.window.until ?? "…"}`;
  // UX-41 null-arm precedence: no accepted → no steps → unpriced steps.
  const unmeasured =
    t.accepted === 0
      ? na(0, "accepted")
      : r.tpac_steps === 0
        ? na(0, "steps")
        : null;
  const tpac =
    r.tpac_micro_usd !== null
      ? `${usd(r.tpac_micro_usd)} / accepted change`
      : (unmeasured ?? na(r.tpac_unpriced_steps, "unpriced steps"));
  const north: [string, string][] = [
    ["window", windowLabel],
    [
      "FPAR",
      r.fpar === null
        ? na(0, "tasks")
        : `${pct(r.fpar)} (${t.accepted} of ${closed} closed)`,
    ],
    ["TPAC", tpac],
    [
      "tokens",
      r.tokens_per_accepted !== null
        ? `${ktok(r.tokens_per_accepted)} / accepted change`
        : (unmeasured ?? na(0, "accepted")),
    ],
  ];
  // Labels come from the report's own counts — never re-derived (F-085):
  // a delivered-then-abandoned task is in the kernel denominator.
  const c = r.correction;
  const secondary: [string, string][] = [
    [
      "correction",
      c.rate === null
        ? na(0, "delivered")
        : `${pct(c.rate)} (${c.corrected} of ${c.delivered} delivered)`,
    ],
    ["drift", `${r.spec_drift_incidents} incidents`],
    [
      "gate pass",
      r.gate.pass_rate === null
        ? na(0, "verdicts")
        : `${pct(r.gate.pass_rate)} (${r.gate.helps} helps · ${r.gate.hurts} hurts · ${r.gate.no_effect} no effect · ${r.gate.underpowered} underpowered)`,
    ],
    ["regret", `${r.routing_regret_events} routing regret events`],
    [
      "overhead",
      r.overhead.ratio !== null
        ? `${pct(r.overhead.ratio)} (${usd(r.overhead.eval_spend_micro_usd)} eval / ${usd(r.overhead.product_spend_micro_usd)} product)`
        : r.overhead.unpriced_steps > 0
          ? na(r.overhead.unpriced_steps, "unpriced steps")
          : na(0, "product spend"),
    ],
  ];
  const s = r.sessions;
  // Two rows: one line would break UX-4's 80 columns.
  const sessionRows: [string, string][] = [
    [
      "sessions",
      `${s.total} total · ${s.complete} complete · ${s.incomplete} incomplete · ${s.degraded} degraded`,
    ],
    [
      "runners",
      `cc ${s.by_runner.cc} · native ${s.by_runner.native} · unknown ${s.by_runner.unknown}`,
    ],
  ];
  const models =
    r.cost_by_model.length === 0
      ? "no steps in window"
      : table(
          [
            { header: "model" },
            { header: "steps", align: "right" },
            { header: "tokens", align: "right" },
            { header: "cost", align: "right" },
          ],
          r.cost_by_model.map((m) => [
            m.model,
            String(m.steps),
            ktok(m.tokens),
            m.cost_micro_usd === null
              ? na(m.unpriced_steps, "unpriced")
              : usd(m.cost_micro_usd),
          ]),
        );
  return panel(
    "obligato metrics",
    [
      kvGrid(north),
      "",
      kvGrid(secondary),
      "",
      models,
      "",
      kvGrid(sessionRows),
    ].join("\n"),
  );
};

// UX-41: computeMetrics is the single source (TEL-8); rendering formats,
// never re-derives. Diagnostics never mutate: a missing store is refused
// before openDb (which would create it).
export const metricsCommand = async (argv: string[]): Promise<void> => {
  const { named } = parseArgs(argv);
  const dbPath = typeof named.db === "string" ? named.db : DEFAULT_DB_PATH;
  if (!existsSync(dbPath))
    return fail(`no store at ${dbPath} — run \`obligato init\``);
  const window = {
    ...(typeof named.since === "string" ? { since: named.since } : {}),
    ...(typeof named.until === "string" ? { until: named.until } : {}),
  };
  const db = openDb(dbPath);
  try {
    const report = computeMetrics(db, window);
    if (named.json === true) emitJson(report);
    else write(renderMetrics(report));
    if (typeof named.otel === "string") {
      const exported = await exportMetricsOtel(db, named.otel, window);
      if (named.json !== true)
        write(`exported ${exported.gauges} gauges to ${named.otel}/v1/metrics`);
    }
  } finally {
    db.close();
  }
};
