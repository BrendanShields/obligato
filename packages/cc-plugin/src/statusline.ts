// Statusline segment stub (plan Task 7): `stage · model · budget`, with stage
// and budget hardcoded until Phase 3. Reads the Claude Code statusline JSON.
export const renderStatusline = (input: unknown): string => {
  const model =
    (input as { model?: { display_name?: string } })?.model?.display_name ??
    "?";
  return `obligato ⛭ build · ${model} · budget —`;
};

if (import.meta.main) {
  const raw = await Bun.stdin.text();
  let input: unknown = {};
  try {
    input = JSON.parse(raw);
  } catch {
    /* statusline must render something even on bad input */
  }
  console.log(renderStatusline(input));
}
