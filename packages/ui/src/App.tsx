import { useEffect, useState } from "react";
import Evals from "./views/Evals";
import Loop from "./views/Loop";
import Palette from "./views/Palette";
import Session from "./views/Session";
import Telemetry from "./views/Telemetry";
import Trace from "./views/Trace";

const VIEWS = {
  "#/": { title: "telemetry", el: <Telemetry /> },
  "#/evals": { title: "evals", el: <Evals /> },
  "#/loop": { title: "loop", el: <Loop /> },
  "#/trace": { title: "trace", el: <Trace /> },
} as const;

type Route = keyof typeof VIEWS;

// UX-50: the one parameterised hash route; everything else is the table.
const resolve = (hash: string): { route: Route; session: string | null } => {
  const h = hash || "#/";
  const m = /^#\/session\/(.+)$/.exec(h);
  if (m) {
    let id = m[1] as string;
    try {
      id = decodeURIComponent(id);
    } catch {
      // malformed percent-encoding: keep the literal segment
    }
    return { route: "#/", session: id };
  }
  return { route: h in VIEWS ? (h as Route) : "#/", session: null };
};

export default function App() {
  const [loc, setLoc] = useState(() => resolve(window.location.hash));
  useEffect(() => {
    const onHash = () => setLoc(resolve(window.location.hash));
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
          obligato<span style={{ color: "var(--series-1)" }}>▮</span>
        </span>
        <nav className="flex gap-4">
          {(Object.keys(VIEWS) as Route[]).map((r) => (
            <a
              key={r}
              href={r}
              className="mono text-sm"
              style={{
                color:
                  loc.route === r ? "var(--text-primary)" : "var(--text-muted)",
                borderBottom:
                  loc.route === r
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
          read-only · actions via CLI · ⌘K search
        </span>
      </header>
      <main className="p-6 max-w-6xl mx-auto">
        {loc.session !== null ? (
          <Session id={loc.session} />
        ) : (
          VIEWS[loc.route].el
        )}
      </main>
      <Palette />
    </div>
  );
}
