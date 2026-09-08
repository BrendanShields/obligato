import { describe, expect, it } from "bun:test";
import { runTurn } from "../../src/loop.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";

describe("UX-47 (loop arm): onToolStart carries the call's input as its third argument", () => {
  it("a write call fires onToolStart with (name, primaryArg, input) — input deep-equal to the request", async () => {
    const input = { path: "a.txt", content: "x" };
    const f = fixture([
      toolCallResponse([{ id: "w1", name: "write", input }]),
      textResponse("done"),
    ]);
    const starts: [string, string, unknown][] = [];
    // PERM-3: resolve the write's default ask headlessly so the call runs
    // (UX-36 pins that onToolStart fires only once a call resolves).
    const r = await runTurn({
      ...f.deps,
      headlessAsk: "allow",
      onToolStart: (name, arg, callInput) =>
        starts.push([name, arg, callInput]),
    });
    expect(r.status).toBe("done");
    // revert-check: drop the third argument at the resolveTools call site →
    // the tuple's third slot reads undefined and the deep-equal fails.
    expect(starts).toEqual([["write", "a.txt", input]]);
  });
});
