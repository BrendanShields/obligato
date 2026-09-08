import type { UiSessionItem, UiSessionView } from "@obligato/schemas";
import { fmtMicroUsd, fmtTokens, usePoll } from "../api";
import {
  Pending,
  PolledEmpty,
  Section,
  StaleBadge,
  Status,
  Tile,
} from "../components";

// UX-50: the per-session timeline — rowid stream rendered vertically.
const cost = (v: number | null): string =>
  v === null ? "n/a" : fmtMicroUsd(v);

// elapsed since the previous item, derivable only from `at`
const elapsed = (prev: string | null, at: string): string => {
  if (prev === null) return "";
  const ms = Date.parse(at) - Date.parse(prev);
  return Number.isFinite(ms) && ms >= 0 ? `+${(ms / 1000).toFixed(1)}s` : "";
};

const MARK: Record<UiSessionItem["kind"], string> = {
  user: "❯",
  step: "●",
  tool: "▸",
  permission: "⚑",
  compaction: "≡",
  model_switch: "⇄",
  escalation: "↑",
  obligation: "◆",
  fork: "⑂",
  meta: "·",
  budget: "$",
};

const short = (id: string): string => `${id.slice(0, 8)}…`;

function Detail({ it }: { it: UiSessionItem }) {
  const muted = { color: "var(--text-muted)" };
  switch (it.kind) {
    case "user":
      return <span>{it.preview}</span>;
    case "step":
      return (
        <span>
          <span
            className="mono text-xs px-1 rounded mr-2"
            style={{ background: "var(--page)", color: "var(--series-1)" }}
          >
            {it.model}
          </span>
          <span style={muted}>
            {fmtTokens(it.tokens_in + it.tokens_out)} · {it.tool_calls} calls ·{" "}
            {cost(it.cost_micro_usd)}
          </span>
          {it.preview !== "" && <span className="ml-2">{it.preview}</span>}
        </span>
      );
    case "tool":
      return (
        <span>
          <span
            style={{
              color: it.ok ? "var(--status-good)" : "var(--status-critical)",
            }}
          >
            {it.ok ? "✓" : "✗"} {it.name}
          </span>
          <span className="ml-2" style={muted}>
            {it.detail}
          </span>
        </span>
      );
    case "permission":
      return (
        <span style={{ color: "var(--status-warning)" }}>
          permission {it.phase} · {it.tool} {it.detail}
        </span>
      );
    case "compaction":
      return (
        <span style={muted}>
          compacted {short(it.from_event)} → {short(it.to_event)}
        </span>
      );
    case "model_switch":
      return (
        <span>
          {it.from} → {it.to}
        </span>
      );
    case "escalation":
      return <span>escalated → {it.model}</span>;
    case "obligation":
      return (
        <span
          style={{
            color:
              it.status === "pass"
                ? "var(--status-good)"
                : "var(--status-critical)",
          }}
        >
          {it.status === "pass" ? "✓" : "✗"} {it.clause_id} {it.status}
        </span>
      );
    case "fork":
      return <span style={muted}>fork from {short(it.from_event)}</span>;
    case "meta":
      return <span style={muted}>{it.keys.join(", ")}</span>;
    case "budget":
      return (
        <span style={{ color: "var(--status-warning)" }}>
          {it.event} · {it.detail}
        </span>
      );
  }
}

export default function Session({ id }: { id: string }) {
  const path = `/api/session/${encodeURIComponent(id)}`;
  const poll = usePoll<UiSessionView>(path);
  const { data } = poll;
  if (!data) return <Pending path={path} error={poll.error} />;
  if (data.session === null)
    return <PolledEmpty poll={poll} verb={data.empty_verb} />;
  const s = data.session;
  let prev: string | null = null;
  return (
    <div>
      <StaleBadge poll={poll} />
      <a
        href="#/"
        className="mono text-sm"
        style={{ color: "var(--text-muted)" }}
      >
        ← telemetry
      </a>
      <Section title="session">
        <div className="flex gap-4 flex-wrap">
          <Tile label="session" value={short(s.id)}>
            <div
              className="text-xs mt-1"
              style={{ color: "var(--text-muted)" }}
            >
              {s.repo} · {s.runner ?? "unknown runner"} ·{" "}
              {s.auth_kind ?? "unknown auth"}
            </div>
          </Tile>
          <Tile label="status" value="">
            <Status value={s.status} />
          </Tile>
          <Tile label="model" value={s.model ?? "unknown"} />
          <Tile label="steps" value={String(s.steps)} />
          <Tile label="tokens" value={fmtTokens(s.tokens)} />
          <Tile label="cost" value={cost(s.cost_micro_usd)}>
            {s.unpriced_steps > 0 && (
              <div
                className="text-xs mt-1"
                style={{ color: "var(--status-warning)" }}
              >
                ~ {s.unpriced_steps} unpriced steps
              </div>
            )}
          </Tile>
        </div>
      </Section>
      <Section title="timeline">
        <div className="card p-2">
          {data.items.length === 0 && (
            <p className="p-2" style={{ color: "var(--text-muted)" }}>
              no events yet
            </p>
          )}
          {data.items.map((it) => {
            const gap = elapsed(prev, it.at);
            prev = it.at;
            return (
              <div
                key={it.id}
                className="flex items-baseline gap-3 px-2 py-1"
                style={{ borderTop: "1px solid var(--grid)" }}
              >
                <span
                  className="mono w-6 text-right"
                  style={{ color: "var(--text-muted)" }}
                >
                  {it.seq}
                </span>
                <span className="w-4" style={{ color: "var(--series-1)" }}>
                  {MARK[it.kind]}
                </span>
                <span
                  className="mono text-xs w-20"
                  style={{ color: "var(--text-muted)" }}
                >
                  {it.at.slice(11, 19)}
                </span>
                <span
                  className="mono text-xs w-14"
                  style={{ color: "var(--text-muted)" }}
                >
                  {gap}
                </span>
                <span
                  className="mono text-xs w-24"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {it.kind}
                </span>
                <span className="flex-1 truncate">
                  <Detail it={it} />
                </span>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
