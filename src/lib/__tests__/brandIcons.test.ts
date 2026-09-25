import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const png = (rel: string) => {
  const b = readFileSync(new URL(rel, root));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };
};

describe("brand icons", () => {
  it("has the Router mark as the icon source", () => {
    for (const f of ["agmux-mark.svg", "agmux-app-icon.svg", "agmux-square-icon.svg"]) {
      const svg = readFileSync(new URL(`src-tauri/icons/source/${f}`, root), "utf8");
      expect(svg).toContain("M405 231 L606 351 L606 673 L405 793 Z"); // mux body
      expect(svg).toContain("M234 512 H738"); // gold route through the body
      expect(svg).toContain("#f2a516"); // routed output
    }
  });

  it("keeps equal padding on every side of the app icon glyph", () => {
    for (const f of ["agmux-app-icon.svg", "agmux-square-icon.svg"]) {
      const svg = readFileSync(new URL(`src-tauri/icons/source/${f}`, root), "utf8");
      // 620px glyph box centered at 512, scaled 0.875 about the center.
      expect(svg).toContain('<g transform="translate(64 64) scale(0.875)">');
    }
  });

  it.each([
    ["public/xanom-icon.png", 256], ["src/assets/xanom-icon.png", 256], ["src/assets/xanom-app-icon.png", 256],
    ["remote-relay/public/icons/agmux.png", 64], ["remote-relay/public/icons/agmux-192.png", 192],
    ["remote-relay/public/icons/agmux-512.png", 512], ["remote-mobile/www/icons/agmux-512.png", 512],
    ["src-tauri/icons/1024x1024.png", 1024],
  ])("%s is %ipx square", (rel, size) => {
    const { w, h } = png(rel);
    expect([w, h]).toEqual([size, size]);
  });

  it("gives iOS an icon without alpha", () => {
    const { colorType } = png("remote-mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
    expect(colorType).toBe(2); // truecolor, no alpha
  });
});
