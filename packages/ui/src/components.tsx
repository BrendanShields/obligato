import type { ReactNode } from "react";

// UX-12: the designed empty state — the verb is the interface
export function Empty({ verb }: { verb: string }) {
  return (
    <div className="card p-8 text-center">
      <p style={{ color: "var(--text-muted)" }}>
        no data yet — produce some with
      </p>
      <code
        className="mono mt-2 inline-block px-2 py-1 rounded"
        style={{ background: "var(--page)", color: "var(--text-secondary)" }}
      >
        {verb}
      </code>
    </div>
  );
}

export function Tile({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <div className="card p-4 flex-1 min-w-40">
      <div
        className="text-xs uppercase tracking-wide"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </div>
      <div className="text-2xl mt-1">{value}</div>
      {children}
    </div>
  );
}

export function Sparkline({
  values,
  stroke,
}: {
  values: number[];
  stroke: string;
}) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 28;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg width={w} height={h} className="mt-2" role="img" aria-label="trend">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={2} />
    </svg>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2
        className="text-sm uppercase tracking-wide mb-2"
        style={{ color: "var(--text-secondary)" }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

const STATUS: Record<string, { color: string; symbol: string }> = {
  helps: { color: "var(--status-good)", symbol: "✓" },
  hurts: { color: "var(--status-critical)", symbol: "✗" },
  no_effect: { color: "var(--status-neutral)", symbol: "~" },
  underpowered: { color: "var(--status-warning)", symbol: "?" },
  complete: { color: "var(--status-good)", symbol: "✓" },
  incomplete: { color: "var(--status-warning)", symbol: "~" },
  degraded: { color: "var(--status-critical)", symbol: "✗" },
};

// color never alone: symbol + label always accompany (UX §7)
export function Status({ value }: { value: string }) {
  const s = STATUS[value] ?? { color: "var(--status-neutral)", symbol: "?" };
  return (
    <span style={{ color: s.color }}>
      {s.symbol} {value}
    </span>
  );
}
