import { describe, expect, it } from "bun:test";
import { COMMANDS } from "../../src/index.ts";
import {
  answerField,
  cancel,
  complete,
  createModel,
  selectSpec,
  WIZARDS,
} from "../../src/wizards.ts";

const spec = (title: string) => {
  const s = WIZARDS.find((w) => w.title === title);
  if (!s) throw new Error(`no wizard spec: ${title}`);
  return s;
};

describe("UX-8: wizards dispatch through the same entry function as the typed command; a cancelled wizard executes nothing", () => {
  it("completion calls the shared COMMANDS entry with the assembled argv", async () => {
    const calls: string[][] = [];
    const original = COMMANDS.eval;
    COMMANDS.eval = (argv) => {
      calls.push(argv);
    };
    try {
      let m = createModel();
      m = selectSpec(m, spec("eval ablate"));
      m = answerField(m, "acme-pack");
      m = answerField(m, "suites/seed");
      expect(m.state).toBe("done");
      // the wizard's dispatch resolves through the SAME table the typed
      // path (`kelson eval ...`) resolves through — patching that one
      // entry intercepts both, which is the identity being asserted
      await complete(m, COMMANDS);
      expect(calls).toEqual([
        ["ablate", "acme-pack", "--suite", "suites/seed"],
      ]);
    } finally {
      COMMANDS.eval = original as (typeof COMMANDS)["eval"];
    }
  });

  it("optional blank fields are omitted from argv", async () => {
    const calls: string[][] = [];
    const original = COMMANDS.route;
    COMMANDS.route = (argv) => {
      calls.push(argv);
    };
    try {
      let m = createModel();
      m = selectSpec(m, spec("route explain"));
      m = answerField(m, "");
      expect(m.state).toBe("done");
      await complete(m, COMMANDS);
      expect(calls).toEqual([["explain"]]);
    } finally {
      COMMANDS.route = original as (typeof COMMANDS)["route"];
    }
  });

  it("required blank field does not advance the wizard", () => {
    let m = createModel();
    m = selectSpec(m, spec("eval ablate"));
    const before = m;
    m = answerField(m, "   ");
    expect(m).toEqual(before);
    expect(m.state).toBe("fields");
  });

  it("cancel: zero dispatch calls, complete() returns without throwing", async () => {
    const calls: string[][] = [];
    const original = COMMANDS.eval;
    COMMANDS.eval = (argv) => {
      calls.push(argv);
    };
    try {
      let m = createModel();
      m = selectSpec(m, spec("eval ablate"));
      m = answerField(m, "acme-pack");
      m = cancel(m);
      expect(m.state).toBe("cancelled");
      await complete(m, COMMANDS);
      expect(calls).toEqual([]);
    } finally {
      COMMANDS.eval = original as (typeof COMMANDS)["eval"];
    }
  });

  it("every wizard spec resolves to a COMMANDS entry", () => {
    for (const w of WIZARDS) expect(COMMANDS[w.command]).toBeDefined();
  });
});
