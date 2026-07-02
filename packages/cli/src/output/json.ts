// UX-1/UX-9: the --json emitter — the second entry on the UX-9 write-site
// allowlist. Machine output bypasses the component layer by design.

export const emitJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};
