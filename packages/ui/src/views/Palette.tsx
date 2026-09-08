import type { UiSearchHit, UiSearchView } from "@obligato/schemas";
import { useEffect, useRef, useState } from "react";

// UX-51: Cmd-K palette — GET /api/search only; every hit shows the CLI verb
// that acts on it (UX-5). Navigation is hash-only; no write ever leaves here.
const TARGET: Partial<Record<UiSearchHit["kind"], (id: string) => string>> = {
  session: (id) => `#/session/${id}`,
  proposal: () => "#/loop",
  eval_run: () => "#/evals",
  clause: () => "#/trace",
};

export default function Palette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<UiSearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
    else {
      setQ("");
      setHits([]);
      setCursor(0);
      setCopied(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error(`${res.status}`);
        const view = (await res.json()) as UiSearchView;
        if (live) {
          setHits(view.hits);
          setCursor(0);
        }
      } catch {
        if (live) setHits([]);
      }
    }, 120);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [q, open]);

  const copy = async (command: string): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(command);
      setCopied(command);
    } catch {
      setCopied(null);
    }
  };

  const select = (h: UiSearchHit): void => {
    const to = TARGET[h.kind]?.(h.id);
    void copy(h.command);
    if (to !== undefined) {
      window.location.hash = to;
      setOpen(false);
    }
  };

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center pt-24"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={() => setOpen(false)}
      onKeyDown={() => undefined}
    >
      <div
        className="card w-full max-w-2xl p-2"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => undefined}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown")
              setCursor((c) => Math.min(c + 1, Math.max(hits.length - 1, 0)));
            else if (e.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0));
            else if (e.key === "Enter") {
              const h = hits[cursor];
              if (h !== undefined) select(h);
            }
          }}
          placeholder="search sessions, runs, proposals, clauses…"
          className="mono w-full p-2 rounded outline-none"
          style={{
            background: "var(--page)",
            color: "var(--text-primary)",
            border: "1px solid var(--border)",
          }}
        />
        <ul className="mt-2 max-h-96 overflow-y-auto">
          {hits.length === 0 && (
            <li className="p-2 text-sm" style={{ color: "var(--text-muted)" }}>
              {q.trim() === "" ? "type to search" : "no matches"}
            </li>
          )}
          {hits.map((h, i) => (
            <li
              key={`${h.kind}:${h.id}`}
              className="flex items-center gap-3 p-2 rounded cursor-pointer"
              style={{
                background: i === cursor ? "var(--page)" : "transparent",
              }}
              onMouseEnter={() => setCursor(i)}
              onClick={() => select(h)}
              onKeyDown={() => undefined}
            >
              <span
                className="mono text-xs w-20"
                style={{ color: "var(--text-muted)" }}
              >
                {h.kind}
              </span>
              <span className="mono" style={{ color: "var(--series-1)" }}>
                {h.id.length > 12 ? `${h.id.slice(0, 12)}…` : h.id}
              </span>
              <span className="truncate flex-1 text-sm">{h.label}</span>
              <code
                className="mono text-xs"
                style={{ color: "var(--text-secondary)" }}
              >
                {h.command}
              </code>
              <button
                type="button"
                className="mono text-xs px-2 py-1 rounded"
                style={{
                  border: "1px solid var(--border)",
                  color: "var(--text-muted)",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  void copy(h.command);
                }}
              >
                {copied === h.command ? "copied" : "copy"}
              </button>
            </li>
          ))}
        </ul>
        <div className="p-2 text-xs" style={{ color: "var(--text-muted)" }}>
          ↑↓ move · enter open + copy · esc close · read-only: run the command
          in the CLI
        </div>
      </div>
    </div>
  );
}
