import type { UiEvalRunRow, UiEvalView } from "@kelson/schemas";
import { usePoll } from "../api";
import { Empty, Section, Status } from "../components";

// CI dot-and-whisker: numbers always carry their interval (UX §7)
function Whisker({
  delta,
}: {
  delta: NonNullable<UiEvalRunRow["fpar_delta"]>;
}) {
  const [lo, hi] = delta.ci95;
  const span = Math.max(Math.abs(lo), Math.abs(hi), 0.001) * 2.2;
  const x = (v: number) => 90 + (v / span) * 180;
  return (
    <svg
      width={180}
      height={16}
      role="img"
      aria-label={`mean ${delta.mean}, CI ${lo} to ${hi}`}
    >
      <line x1={90} y1={0} x2={90} y2={16} stroke="var(--baseline)" />
      <line
        x1={x(lo)}
        y1={8}
        x2={x(hi)}
        y2={8}
        stroke="var(--text-secondary)"
        strokeWidth={2}
      />
      <circle cx={x(delta.mean)} cy={8} r={4} fill="var(--series-1)" />
    </svg>
  );
}

const fmtDelta = (d: NonNullable<UiEvalRunRow["fpar_delta"]>, unit = "") =>
  `${d.mean >= 0 ? "+" : ""}${d.mean.toFixed(3)}${unit} [${d.ci95[0].toFixed(3)}, ${d.ci95[1].toFixed(3)}]`;

export default function Evals() {
  const { data } = usePoll<UiEvalView>("/api/evals");
  if (!data) return null;
  if (data.runs.length === 0) return <Empty verb={data.empty_verb} />;
  return (
    <Section title="eval runs">
      <div className="flex flex-col gap-3">
        {data.runs.map((r) => (
          <div key={r.id} className="card p-4">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="mono" style={{ color: "var(--series-1)" }}>
                {r.id.slice(0, 10)}…
              </span>
              <span style={{ color: "var(--text-secondary)" }}>
                {r.kind} · {r.suite_id}@{r.suite_version}
              </span>
              {r.decision && <Status value={r.decision} />}
              {r.n !== null && (
                <span style={{ color: "var(--text-muted)" }}>n={r.n}</span>
              )}
              <span className="ml-auto" style={{ color: "var(--text-muted)" }}>
                {r.started_at.slice(0, 16).replace("T", " ")}
                {r.finished_at ? "" : " · running"}
              </span>
            </div>
            {r.fpar_delta && (
              <div className="mt-3 flex items-center gap-4 flex-wrap">
                <span className="w-24" style={{ color: "var(--text-muted)" }}>
                  fpar Δ
                </span>
                <Whisker delta={r.fpar_delta} />
                <span
                  className="mono"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {fmtDelta(r.fpar_delta)}
                </span>
              </div>
            )}
            {r.cost_delta_pct && (
              <div className="mt-1 flex items-center gap-4 flex-wrap">
                <span className="w-24" style={{ color: "var(--text-muted)" }}>
                  cost Δ
                </span>
                <Whisker delta={r.cost_delta_pct} />
                <span
                  className="mono"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {fmtDelta(r.cost_delta_pct, "%")}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}
