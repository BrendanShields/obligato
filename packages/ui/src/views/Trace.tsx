import type { UiTraceView } from "@kelson/schemas";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import { usePoll } from "../api";
import { Empty, Section } from "../components";

// layered layout: artifact types are the columns of the traceability DAG
const TYPE_ORDER = [
  "signal",
  "idea",
  "prd",
  "erd",
  "adr",
  "spec",
  "code_region",
  "test",
];

export default function Trace() {
  const { data } = usePoll<UiTraceView>("/api/trace");
  const [selected, setSelected] = useState<string | null>(null);

  const flow = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    const perCol: Record<string, number> = {};
    const nodes = data.nodes.map((n) => {
      const col = TYPE_ORDER.indexOf(n.type);
      const row = (perCol[n.type] = (perCol[n.type] ?? 0) + 1);
      return {
        id: n.logical_id,
        position: { x: col * 240, y: row * 70 },
        data: { label: `${n.drift_open ? "~ " : ""}${n.logical_id}` },
        style: {
          background: "var(--surface-1)",
          color: n.drift_open ? "var(--status-warning)" : "var(--text-primary)",
          border: `1px solid ${n.drift_open ? "var(--status-warning)" : "var(--border)"}`,
          borderRadius: 6,
          fontSize: 11,
          fontFamily: "ui-monospace, monospace",
        },
      };
    });
    const edges = data.edges.map((e) => ({
      id: `${e.upstream_id}->${e.downstream_id}`,
      source: e.upstream_id,
      target: e.downstream_id,
      style: { stroke: "var(--baseline)" },
    }));
    return { nodes, edges };
  }, [data]);

  if (!data) return null;
  if (data.nodes.length === 0) return <Empty verb={data.empty_verb} />;
  const sel = data.nodes.find((n) => n.logical_id === selected);
  return (
    <Section title="traceability — clauses → obligations → artifacts (~ = open drift)">
      <div className="flex gap-3">
        <div className="card" style={{ height: 560, flex: 1 }}>
          <ReactFlow
            nodes={flow.nodes}
            edges={flow.edges}
            onNodeClick={(_e, node) => setSelected(node.id)}
            fitView
            colorMode="dark"
            nodesConnectable={false}
            nodesDraggable={false}
          >
            <Background color="var(--grid)" />
            <Controls />
          </ReactFlow>
        </div>
        {sel && (
          <div className="card p-4 w-72 shrink-0">
            <div className="mono" style={{ color: "var(--series-1)" }}>
              {sel.logical_id}
            </div>
            <dl
              className="mt-2 text-sm"
              style={{ color: "var(--text-secondary)" }}
            >
              <dt style={{ color: "var(--text-muted)" }}>type</dt>
              <dd>{sel.type}</dd>
              <dt className="mt-1" style={{ color: "var(--text-muted)" }}>
                authority · tier
              </dt>
              <dd>
                {sel.authority} · {sel.tier}
              </dd>
              <dt className="mt-1" style={{ color: "var(--text-muted)" }}>
                content hash
              </dt>
              <dd className="mono break-all text-xs">{sel.content_hash}</dd>
              <dt className="mt-1" style={{ color: "var(--text-muted)" }}>
                drift
              </dt>
              <dd>
                {sel.drift_open ? "~ open — kelson drift list" : "✓ none"}
              </dd>
            </dl>
          </div>
        )}
      </div>
    </Section>
  );
}
