import type { UiLoopView } from "@kelson/schemas";
import { usePoll } from "../api";
import { Empty, Section } from "../components";

// columns mirror the LOOP state machine; every state names its verb (UX-P5)
const COLUMNS: { states: string[]; title: string; verb: string }[] = [
  { states: ["proposed"], title: "proposed", verb: "kelson loop gate <id>" },
  {
    states: ["gated"],
    title: "gated",
    verb: "kelson loop approve <id> --reason ...",
  },
  { states: ["approved"], title: "approved", verb: "kelson loop apply <id>" },
  {
    states: ["applied", "monitoring"],
    title: "applied",
    verb: "kelson loop status",
  },
  { states: ["stable"], title: "stable", verb: "—" },
  {
    states: ["rejected", "reverted", "quarantined"],
    title: "closed",
    verb: "kelson loop release <id>",
  },
];

export default function Loop() {
  const { data } = usePoll<UiLoopView>("/api/loop");
  if (!data) return null;
  if (data.proposals.length === 0 && data.changelog.length === 0)
    return <Empty verb={data.empty_verb} />;
  return (
    <div>
      <Section title="proposals">
        <div className="flex gap-3 overflow-x-auto items-start">
          {COLUMNS.map((col) => {
            const cards = data.proposals.filter((p) =>
              col.states.includes(p.state),
            );
            return (
              <div key={col.title} className="card p-3 min-w-52 flex-1">
                <div
                  className="text-xs uppercase tracking-wide mb-2"
                  style={{ color: "var(--text-muted)" }}
                >
                  {col.title} ({cards.length})
                </div>
                {cards.map((p) => (
                  <div
                    key={p.id}
                    className="rounded p-2 mb-2"
                    style={{
                      background: "var(--page)",
                      border: "1px solid var(--grid)",
                    }}
                  >
                    <div className="mono" style={{ color: "var(--series-1)" }}>
                      {p.id.slice(0, 10)}…
                    </div>
                    <div style={{ color: "var(--text-secondary)" }}>
                      {p.target_pack}
                    </div>
                    <div
                      className="text-xs mt-1"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {p.rationale.slice(0, 80)}
                    </div>
                    <div className="text-xs mt-1">
                      {p.state === "quarantined" ? "⏸ " : ""}
                      {p.created_by}
                    </div>
                  </div>
                ))}
                {cards.length > 0 && col.verb !== "—" && (
                  <code
                    className="mono text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {col.verb}
                  </code>
                )}
              </div>
            );
          })}
        </div>
      </Section>
      <Section title="changelog">
        <div className="card p-2">
          {data.changelog.length === 0 && (
            <p className="p-2" style={{ color: "var(--text-muted)" }}>
              no applied changes yet
            </p>
          )}
          {data.changelog.map((e) => (
            <div
              key={e.seq}
              className="flex gap-3 p-2"
              style={{ borderTop: "1px solid var(--grid)" }}
            >
              <span className="mono" style={{ color: "var(--text-muted)" }}>
                #{e.seq}
              </span>
              <span
                style={{
                  color:
                    e.action === "revert"
                      ? "var(--status-critical)"
                      : "var(--text-primary)",
                }}
              >
                {e.action}
              </span>
              <span className="mono" style={{ color: "var(--series-1)" }}>
                {e.proposal_id ? `${e.proposal_id.slice(0, 10)}…` : "(human)"}
              </span>
              <span
                className="flex-1"
                style={{ color: "var(--text-secondary)" }}
              >
                {e.evidence_summary}
              </span>
              <span style={{ color: "var(--text-muted)" }}>
                {e.at.slice(0, 16).replace("T", " ")}
              </span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
