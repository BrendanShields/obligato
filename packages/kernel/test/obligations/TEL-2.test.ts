import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// TEL-2's strongest form: the kernel and schemas packages contain no network
// path at all — nothing to opt out of. The full-session network-recorder
// integration test lives in packages/cc-plugin/test/obligations/TEL-2.test.ts.
const NETWORK_PATTERNS = [
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

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));

describe("TEL-2: telemetry has no off-machine path unless explicitly opted in", () => {
  it("kernel and schemas sources import no network module and open no socket", () => {
    const root = join(import.meta.dir, "..", "..", "..");
    const files = [
      ...sourceFiles(join(root, "kernel", "src")),
      ...sourceFiles(join(root, "schemas", "src")),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const pattern of NETWORK_PATTERNS) expect(src).not.toMatch(pattern);
    }
  });
});
