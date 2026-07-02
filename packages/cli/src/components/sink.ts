// UX-9: the component layer's single stdout sink — the only permitted
// rendered-output write site outside the file-path allowlist. Non-TTY
// degrades to plain sequential text (UX-4): ANSI stripped, box glyphs kept.

const plain = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for the non-TTY plain fallback
  s.replace(/\x1b\[[0-9;]*m/g, "");

export const write = (rendered: string): void => {
  const out =
    process.stdout.isTTY === true && process.env.NO_COLOR === undefined
      ? rendered
      : plain(rendered);
  process.stdout.write(`${out}\n`);
};
