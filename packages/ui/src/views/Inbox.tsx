import type { UiInboxView } from "@obligato/schemas";
import { usePoll } from "../api";
import { Empty, Section } from "../components";

// UX-42: the ambient face of the attention queue — every row names its one
// verb as a copyable command (UX-P5); the CLI/launcher act, the web shows.
const fmtAge = (s: number | null): string => {
  if (s === null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h`;
  return `${Math.floor(s / 86_400)}d`;
};

export default function Inbox() {
  const { data } = usePoll<UiInboxView>("/api/inbox");
  if (!data) return null;
  if (data.items.length === 0) return <Empty verb={data.empty_verb} />;
  return (
    <Section title={`awaiting you (${data.items.length})`}>
      <div className="card overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr style={{ color: "var(--text-muted)" }}>
              <th className="p-2 font-normal">kind</th>
              <th className="p-2 font-normal">item</th>
              <th className="p-2 font-normal text-right">age</th>
              <th className="p-2 font-normal">verb</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr
                key={`${i.kind}:${i.id}`}
                style={{ borderTop: "1px solid var(--grid)" }}
              >
                <td className="p-2 mono" style={{ color: "var(--series-1)" }}>
                  {i.kind}
                </td>
                <td className="p-2" style={{ color: "var(--text-secondary)" }}>
                  {i.summary}
                </td>
                <td className="p-2 text-right mono">{fmtAge(i.age_seconds)}</td>
                <td className="p-2">
                  <code className="mono text-xs">{i.verb}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
