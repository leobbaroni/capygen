import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Mascot } from "./Mascot";

describe("Mascot", () => {
  it("renders the idle frame by default", () => {
    const html = renderToStaticMarkup(<Mascot />);
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("mascot/pixel-animations.png");
    expect(html).toContain('role="img"');
    expect(html).toContain("width:144px");
    expect(html).toContain("capygen mascot, idle");
    expect(html).toContain("capygen-mascot--idle");
  });

  it("renders the requested state's frame and label", () => {
    const html = renderToStaticMarkup(<Mascot state="error" />);
    expect(html).toContain('data-state="error"');
    expect(html).toContain("mascot/pixel-animations.png");
    expect(html).toContain("background-position-y:-720px");
    expect(html).toContain("capygen mascot, something went wrong");
    expect(html).toContain("capygen-mascot--error");
  });

  it("sizes the wrapper from the size prop and forwards className", () => {
    const html = renderToStaticMarkup(<Mascot size={96} className="extra-class" />);
    expect(html).toContain("width:96px");
    expect(html).toContain("height:96px");
    expect(html).toContain("extra-class");
    expect(html).toContain("capygen-mascot");
  });

  it("presents one accessible image with no fading duplicate", () => {
    const html = renderToStaticMarkup(<Mascot state="working" />);
    expect(html.split('role="img"').length - 1).toBe(1);
    expect(html).not.toContain("layer--out");
    expect(html).toContain("capygen mascot, working");
  });
});
