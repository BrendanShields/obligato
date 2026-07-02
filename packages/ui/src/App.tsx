import { useEffect, useState } from "react";
import Evals from "./views/Evals";
import Loop from "./views/Loop";
import Telemetry from "./views/Telemetry";
import Trace from "./views/Trace";

const VIEWS = {
  "#/": { title: "telemetry", el: <Telemetry /> },
  "#/evals": { title: "evals", el: <Evals /> },
  "#/loop": { title: "loop", el: <Loop /> },
  "#/trace": { title: "trace", el: <Trace /> },
} as const;

type Route = keyof typeof VIEWS;

export default function App() {
  const [route, setRoute] = useState<Route>(
    (window.location.hash || "#/") in VIEWS
      ? ((window.location.hash || "#/") as Route)
      : "#/",
  );
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash || "#/";
      if (h in VIEWS) setRoute(h as Route);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return (
    <div className="min-h-screen">
      <header
        className="flex items-center gap-6 px-6 py-3 sticky top-0 z-10"
        style={{
          background: "var(--page)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          className="mono font-bold"
          style={{ color: "var(--text-primary)" }}
        >
          kelson<span style={{ color: "var(--series-1)" }}>▮</span>
        </span>
        <nav className="flex gap-4">
          {(Object.keys(VIEWS) as Route[]).map((r) => (
            <a
              key={r}
              href={r}
              className="mono text-sm"
              style={{
                color:
                  route === r ? "var(--text-primary)" : "var(--text-muted)",
                borderBottom:
                  route === r
                    ? "2px solid var(--series-1)"
                    : "2px solid transparent",
                paddingBottom: 2,
              }}
            >
              {VIEWS[r].title}
            </a>
          ))}
        </nav>
        <span
          className="ml-auto text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          read-only · actions via CLI
        </span>
      </header>
      <main className="p-6 max-w-6xl mx-auto">{VIEWS[route].el}</main>
    </div>
  );
}
