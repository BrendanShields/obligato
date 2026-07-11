import type { UiTelemetryView } from "@obligato/schemas";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtMicroUsd, fmtTokens, usePoll } from "../api";
import { Empty, Section, Sparkline, Status, Tile } from "../components";

const axis = {
  stroke: "var(--baseline)",
  tick: { fill: "var(--text-muted)", fontSize: 11 },
};
const tooltipStyle = {
  contentStyle: {
    background: "var(--surface-1)",
    border: "1px solid var(--border)",
    color: "var(--text-primary)",
  },
};

// one measure per chart — never dual-axis; tokens and cost are small multiples
function Series({
  data,
  dataKey,
  stroke,
  format,
}: {
  data: UiTelemetryView["series"];
  dataKey: "tokens" | "cost_micro_usd";
  stroke: string;
  format: (v: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="day" {...axis} tickLine={false} />
        <YAxis {...axis} tickLine={false} width={70} tickFormatter={format} />
        <Tooltip {...tooltipStyle} formatter={(v) => format(v as number)} />
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={stroke}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default function Telemetry() {
  const { data } = usePoll<UiTelemetryView>("/api/telemetry");
  if (!data) return null;
  if (data.sessions_count === 0) return <Empty verb={data.empty_verb} />;
  const maxSteps = Math.max(...data.models.map((m) => m.steps), 1);
  return (
    <div>
      <Section title="totals">
        <div className="flex gap-4 flex-wrap">
          <Tile label="sessions" value={String(data.sessions_count)} />
          <Tile label="tokens in" value={fmtTokens(data.tokens_in)}>
            <Sparkline
              values={data.series.map((p) => p.tokens)}
              stroke="var(--series-1)"
            />
          </Tile>
          <Tile label="tokens out" value={fmtTokens(data.tokens_out)} />
          <Tile label="cost" value={fmtMicroUsd(data.cost_micro_usd)}>
            <Sparkline
              values={data.series.map((p) => p.cost_micro_usd)}
              stroke="var(--series-2)"
            />
          </Tile>
        </div>
      </Section>
      <Section title="tokens / day">
        <div className="card p-3">
          <Series
            data={data.series}
            dataKey="tokens"
            stroke="var(--series-1)"
            format={fmtTokens}
          />
        </div>
      </Section>
      <Section title="cost / day">
        <div className="card p-3">
          <Series
            data={data.series}
            dataKey="cost_micro_usd"
            stroke="var(--series-2)"
            format={fmtMicroUsd}
          />
        </div>
      </Section>
      <Section title="model mix">
        <div className="card p-4 flex flex-col gap-2">
          {data.models.map((m) => (
            <div key={m.model} className="flex items-center gap-3">
              <span
                className="mono w-56 truncate"
                style={{ color: "var(--text-secondary)" }}
              >
                {m.model}
              </span>
              <div
                className="h-3 rounded-r"
                style={{
                  width: `${(m.steps / maxSteps) * 60}%`,
                  background: "var(--series-1)",
                  minWidth: 2,
                }}
              />
              <span style={{ color: "var(--text-muted)" }}>
                {m.steps} steps
              </span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="recent sessions">
        <div className="card p-2 overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr style={{ color: "var(--text-muted)" }}>
                <th className="p-2 font-normal">id</th>
                <th className="p-2 font-normal">repo</th>
                <th className="p-2 font-normal">status</th>
                <th className="p-2 font-normal text-right">steps</th>
                <th className="p-2 font-normal text-right">tokens</th>
                <th className="p-2 font-normal text-right">cost</th>
              </tr>
            </thead>
            <tbody
              className="mono"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {data.sessions.map((s) => (
                <tr key={s.id} style={{ borderTop: "1px solid var(--grid)" }}>
                  <td className="p-2" style={{ color: "var(--series-1)" }}>
                    {s.id.slice(0, 10)}…
                  </td>
                  <td className="p-2">{s.repo}</td>
                  <td className="p-2">
                    <Status value={s.status} />
                  </td>
                  <td className="p-2 text-right">{s.steps}</td>
                  <td className="p-2 text-right">{fmtTokens(s.tokens)}</td>
                  <td className="p-2 text-right">
                    {fmtMicroUsd(s.cost_micro_usd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
