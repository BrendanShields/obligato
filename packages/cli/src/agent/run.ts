import {
  appendEvent,
  continueSession,
  createAgentSession,
  runTurn,
} from "@obligato/agent";
import { RunResult } from "@obligato/schemas";
import { emitJson } from "../output/json.js";
import { streamOut } from "../output/stream.js";
import { fail, setupAgent, systemPromptFor } from "./common.js";

// UX-15: same runTurn driver as chat, plain text to stdout, --json validated
// against RunResult; exit 0 only when the session reached done.
export const runCommand = async (argv: string[]): Promise<void> => {
  let prompt: string | undefined;
  const named: Record<string, string | true> = {};
  // PERM-5: --allow is repeatable — collected, not last-wins.
  const allows: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-p" || a === "--prompt") {
      prompt = argv[i + 1];
      i++;
    } else if (a === "--allow" && argv[i + 1] !== undefined) {
      allows.push(argv[i + 1] as string);
      i++;
    } else if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        named[a.slice(2)] = next;
        i++;
      } else named[a.slice(2)] = true;
    }
  }
  if (!prompt)
    return fail(
      'usage: obligato run -p "<task>" [--json] [--allow-asks] [--allow <tool[:argGlob]> ...]',
    );
  // PERM-5: split at the FIRST colon — tool glob, optional primary-arg glob.
  const headlessAllows = allows.map((spec) => {
    const idx = spec.indexOf(":");
    const tool = idx === -1 ? spec : spec.slice(0, idx);
    const arg = idx === -1 ? undefined : spec.slice(idx + 1);
    if (!tool) return fail(`--allow needs a tool glob: "${spec}"`);
    return {
      tool,
      ...(arg !== undefined ? { arg } : {}),
      action: "allow" as const,
    };
  });

  const setup =
    typeof named.db === "string"
      ? setupAgent(process.cwd(), named.db)
      : setupAgent();
  const json = named.json === true;
  // SES-4: --continue extends an existing session's chain from its head.
  const { sessionId, head } =
    typeof named.continue === "string"
      ? continueSession(setup.deps.db, named.continue)
      : (() => {
          const created = createAgentSession(setup.deps.db, {
            repo: setup.root,
            lockfile_hash: setup.lockfileHash,
            harness_version: "0.0.1",
            model: setup.entry.id,
            system: systemPromptFor(setup.root),
            auth_kind: setup.authKind,
          });
          return { sessionId: created.sessionId, head: created.rootEventId };
        })();
  appendEvent(setup.deps.db, {
    session_id: sessionId,
    parent_id: head,
    kind: "user_message",
    payload: { text: prompt },
  });

  const result = await runTurn({
    ...setup.deps,
    sessionId,
    // PERM-3: headless ask → deny; --allow-asks resolves asks to allow.
    // PERM-5: granular --allow entries are consulted before the blanket.
    headlessAsk: named["allow-asks"] === true ? "allow" : "deny",
    ...(headlessAllows.length > 0 ? { headlessAllows } : {}),
    ...(json ? {} : { onDelta: streamOut }),
  });

  const rows = setup.deps.db
    .query(
      "SELECT COUNT(*) AS steps, SUM(cost_micro_usd) AS cost, COUNT(*) - COUNT(cost_micro_usd) AS unknowns FROM step_event WHERE session_id = ?",
    )
    .get(sessionId) as { steps: number; cost: number | null; unknowns: number };

  if (json) {
    emitJson(
      RunResult.parse({
        session_id: sessionId,
        status: result.status === "done" ? "done" : "paused",
        text: result.status === "done" ? result.text : "",
        steps: rows.steps,
        cost_micro_usd: rows.unknowns > 0 ? null : (rows.cost ?? 0),
        schema_version: 1,
      }),
    );
  } else {
    streamOut("\n");
    if (result.status === "paused")
      console.error(`obligato: session paused (${result.reason})`);
  }
  if (result.status !== "done") process.exitCode = 1;
};
