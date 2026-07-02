import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Empty } from "../../src/components";

// SPA half of UX-12 (the API half lives in packages/cli): the designed
// empty state displays the producing CLI verb.
describe("UX-12: views render a designed empty state naming the producing CLI verb", () => {
  it("Empty displays the verb", () => {
    const html = renderToStaticMarkup(<Empty verb="kelson loop propose" />);
    expect(html).toContain("kelson loop propose");
    expect(html).toContain("no data yet");
  });
});
