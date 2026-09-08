import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../../src/guardrails.ts";
import { runTurn } from "../../src/loop.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";
import { hook, hookScript, toolResults } from "../hook-helpers.ts";

// Planted secrets are assembled at runtime: a literal token shape in source
// trips GitHub push protection (it blocked this file's first push).
const ANTHROPIC = [
  "sk",
  "ant",
  "api03",
  "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
].join("-");
const GITHUB = `ghp_${"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}`;
const SLACK = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");

const PLANTED: { kind: string; text: string; count: number }[] = [
  { kind: "anthropic_key", text: `key=${ANTHROPIC}`, count: 1 },
  {
    kind: "generic_sk_key",
    text: "token sk-abcdefghijklmnopqrstuvwxyz",
    count: 1,
  },
  {
    kind: "github_token",
    text: `${GITHUB} and github_pat_ABCDEFGHIJKLMNOPQRSTUV_wxyz`,
    count: 2,
  },
  { kind: "aws_access_key", text: "AKIAIOSFODNN7EXAMPLE", count: 1 },
  {
    kind: "private_key",
    text: "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    count: 1,
  },
  { kind: "slack_token", text: `slack ${SLACK}`, count: 1 },
  {
    kind: "bearer_token",
    text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
    count: 1,
  },
  {
    kind: "jwt",
    text: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnopqrstuvwxyz",
    count: 1,
  },
];

describe("SEC-8: tool output is redacted at one point before it is recorded or observed; redactions are recorded on the tool_result", () => {
  it("unit: every kind is replaced by its marker with the right count; near-misses stay", () => {
    for (const p of PLANTED) {
      const r = redactSecrets(p.text);
      expect([p.kind, r.hits]).toEqual([
        p.kind,
        [{ kind: p.kind, count: p.count }],
      ]);
      expect(r.text).toContain(`[REDACTED:${p.kind}]`);
      expect(r.text).not.toContain(ANTHROPIC);
    }
    // revert-check: loosen the 20-char floor on sk- keys → the 19-char string below is redacted.
    for (const miss of [
      "sk-abcdefghijklmnopqrs",
      "Bearer short",
      "AKIAIOSFODNN7EXAMPL",
      "eyJonly.one",
    ]) {
      expect(redactSecrets(miss)).toEqual({ text: miss, hits: [] });
    }
  });

  it("integration (read): the stored payload and the observer both carry the marker, never the key; a clean read records no redactions field", async () => {
    const f = fixture([
      toolCallResponse([{ id: "s8a", name: "read", input: { path: ".env" } }]),
      toolCallResponse([
        { id: "s8b", name: "read", input: { path: "clean.txt" } },
      ]),
      textResponse("ok"),
    ]);
    writeFileSync(join(f.dir, ".env"), `ANTHROPIC_API_KEY=${ANTHROPIC}\n`);
    writeFileSync(join(f.dir, "clean.txt"), "nothing secret here\n");
    const seen: string[] = [];
    f.deps.onToolResult = (_n, _ok, out) => void seen.push(out ?? "");
    await runTurn(f.deps);
    const [secret, clean] = toolResults(f.db, f.sessionId);
    // revert-check: redact after appendEvent → the stored output still holds ANTHROPIC.
    expect(String(secret?.payload.output)).toContain(
      "[REDACTED:anthropic_key]",
    );
    expect(String(secret?.payload.output)).not.toContain(ANTHROPIC);
    expect(secret?.payload.redactions).toEqual([
      { kind: "anthropic_key", count: 1 },
    ]);
    expect(seen[0]).toBe(String(secret?.payload.output));
    expect(seen[0]).not.toContain(ANTHROPIC);
    expect("redactions" in (clean?.payload ?? {})).toBe(false);
    expect(String(clean?.payload.output)).toContain("nothing secret here");
  }, 30_000);

  it("integration (bash + post_tool hook): the second and third crossing paths redact the same way", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "obligato-s8-")));
    const f = fixture(
      [
        toolCallResponse([
          { id: "s8c", name: "bash", input: { command: `echo ${GITHUB}` } },
        ]),
        textResponse("ok"),
      ],
      {
        hooks: [
          hook("post_tool", hookScript(dir, "leak", `echo "${SLACK}"`), {
            matcher: "bash",
          }),
        ],
      },
    );
    f.deps.rules = [{ tool: "bash", action: "allow" }];
    await runTurn(f.deps);
    const tr = toolResults(f.db, f.sessionId)[0];
    const out = String(tr?.payload.output);
    expect(out).toBe("[REDACTED:github_token]\n[hook] [REDACTED:slack_token]");
    expect(tr?.payload.redactions).toEqual([
      { kind: "github_token", count: 1 },
      { kind: "slack_token", count: 1 },
    ]);
  }, 30_000);
});
