import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandLogo } from "./BrandLogo";

describe("BrandLogo", () => {
  it("defaults to the eyes variant at 56px (reference: h-14)", () => {
    const html = renderToStaticMarkup(<BrandLogo />);
    expect(html).toContain("width:56px");
    expect(html).toContain("height:56px");
    expect(html).toContain('data-state="idle"');
  });

  it("renders the icon variant at 16px (reference: h-4)", () => {
    const html = renderToStaticMarkup(<BrandLogo variant="icon" />);
    expect(html).toContain("width:16px");
    expect(html).toContain("height:16px");
  });

  it("forwards className to the underlying mascot", () => {
    const html = renderToStaticMarkup(<BrandLogo className="otto-working shrink-0" />);
    expect(html).toContain("otto-working");
    expect(html).toContain("shrink-0");
  });
});
