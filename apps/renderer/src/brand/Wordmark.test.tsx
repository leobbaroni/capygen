import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Wordmark } from "./Wordmark";

describe("Wordmark", () => {
  it("renders the capygen wordmark text with the brand class", () => {
    const html = renderToStaticMarkup(<Wordmark />);
    expect(html).toContain(">capygen<");
    expect(html).toContain("capygen-wordmark");
  });

  it("forwards a caller-supplied className alongside the brand class", () => {
    const html = renderToStaticMarkup(<Wordmark className="text-lg" />);
    expect(html).toContain("capygen-wordmark");
    expect(html).toContain("text-lg");
  });
});
