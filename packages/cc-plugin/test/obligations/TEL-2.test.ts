import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@kelson/kernel";
import { beginSession, finishSession } from "../../src/session.ts";
import { renderStatus } from "../../src/status.ts";
import { renderStatusline } from "../../src/statusline.ts";

// TEL-2's obligation: with opt-in unset (Phase 0 has no opt-in at all), a
// network-recording harness observes zero outbound calls across a full
// session. The recorder wraps every socket-opening entry point reachable
// from this runtime.
const recorded: string[] = [];
const originals: [object, string, unknown][] = [];
const record = (target: object, prop: string) => {
  const t = target as Record<string, unknown>;
  originals.push([target, prop, t[prop]]);
  t[prop] = (...args: unknown[]) => {
    recorded.push(prop);
    throw new Error(`outbound ${prop}(${String(args[0])}) — TEL-2 violation`);
  };
};

afterEach(() => {
  for (const [target, prop, fn] of originals)
    (target as Record<string, unknown>)[prop] = fn;
  originals.length = 0;
  recorded.length = 0;
});

describe("TEL-2: zero outbound telemetry across a full session with opt-in unset", () => {
  it("full session lifecycle (start → transcript ingest → end → status render) opens no connection", () => {
    record(globalThis, "fetch");
    record(globalThis, "WebSocket");
    record(Bun, "connect");
    record(Bun, "listen");
    record(Bun, "udpSocket");

    const db = openDb(":memory:");
    const session = beginSession(db, process.cwd());
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          model: "m",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
      '{"type":"user","message":{}}',
    ].join("\n");
    expect(finishSession(db, session, transcript)).toEqual({
      steps: 1,
      failed: 0,
    });
    expect(renderStatus(db, process.cwd())).toContain("kelson · status");
    expect(renderStatusline({ model: { display_name: "M" } })).toContain("M");
    db.close();

    expect(recorded).toEqual([]);
  });

  it("cc-plugin sources import no network module (same static scan as the kernel)", () => {
    const patterns = [
      /from\s+["'](node:)?(https?|http2|net|tls|dgram|dns)["']/,
      /require\(["'](node:)?(https?|http2|net|tls|dgram|dns)["']\)/,
      /from\s+["'](undici|axios|node-fetch|got|ky)["']/,
      /\bfetch\s*\(/,
      /new\s+WebSocket\b/,
      /XMLHttpRequest|sendBeacon/,
      /Bun\.(connect|listen|serve|udpSocket|spawn)\b/,
      /from\s+["'](node:)?child_process["']/,
      /["']bun:ffi["']/,
    ];
    const pkgRoot = join(import.meta.dir, "..", "..");
    const files = ["src", "hooks"].flatMap((d) =>
      readdirSync(join(pkgRoot, d), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(pkgRoot, d, f)),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const pattern of patterns) expect(src).not.toMatch(pattern);
    }
  });
});
