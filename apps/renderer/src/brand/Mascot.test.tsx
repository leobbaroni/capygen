import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Mascot } from "./Mascot";

describe("Mascot", () => {
  it("renders the idle frame by default", () => {
    const html = renderToStaticMarkup(<Mascot />);
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("mascot/idle.png");
    expect(html).toContain("capygen mascot, idle");
    expect(html).toContain("capygen-mascot__img--idle");
  });

  it("renders the requested state's frame and label", () => {
    const html = renderToStaticMarkup(<Mascot state="error" />);
    expect(html).toContain('data-state="error"');
    expect(html).toContain("mascot/error.png");
    expect(html).toContain("capygen mascot, something went wrong");
    expect(html).toContain("capygen-mascot__img--error");
  });

  it("sizes the wrapper from the size prop and forwards className", () => {
    const html = renderToStaticMarkup(<Mascot size={96} className="extra-class" />);
    expect(html).toContain("width:96px");
    expect(html).toContain("height:96px");
    expect(html).toContain("extra-class");
    expect(html).toContain("capygen-mascot");
  });

  it("mounts a single frame on first render (no outgoing layer yet)", () => {
    const html = renderToStaticMarkup(<Mascot state="working" />);
    const layerCount = html.split("capygen-mascot__layer ").length - 1;
    expect(layerCount).toBe(1);
  });
});
