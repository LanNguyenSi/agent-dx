import { describe, it, expect } from "vitest";
import { uiSlopPack } from "../src/packs/ui-slop.js";
import type { FileTarget, ResolvedConfig, Rule } from "../src/types.js";

function css(text: string, fileName = "fixture.css"): FileTarget {
  return { path: fileName, text, kind: "style" };
}

function markup(text: string, fileName = "fixture.html"): FileTarget {
  return { path: fileName, text, kind: "markup" };
}

function tsx(text: string, fileName = "fixture.tsx"): FileTarget {
  return { path: fileName, text, kind: "code" };
}

const config: ResolvedConfig = {
  packs: {
    "agent-tics": false,
    "prose-slop": false,
    "comment-slop": false,
    "code-slop": false,
    "ui-slop": true,
  },
  ruleOverrides: {},
  ignorePaths: [],
  treatAsProse: [],
  treatAsCode: [],
};

function findRule(id: string): Rule {
  const r = uiSlopPack.rules.find((rule) => rule.id === id);
  if (!r) throw new Error(`Rule ${id} not in ui-slop pack`);
  return r;
}

function run(ruleId: string, file: FileTarget) {
  const rule = findRule(ruleId);
  return rule.appliesTo(file) ? rule.check({ file, config }) : [];
}

describe("ui-slop/gradient-text", () => {
  it("flags a selector with background-clip:text and a linear-gradient background", () => {
    const v = run(
      "ui-slop/gradient-text",
      css(`
.headline {
  background: linear-gradient(90deg, #7c3aed, #06b6d4);
  -webkit-background-clip: text;
  color: transparent;
}
`),
    );
    expect(v).toHaveLength(1);
    expect(v[0].matched).toMatch(/background-clip\s*:\s*text/);
  });

  it("does not flag background-clip:text without a gradient background", () => {
    const v = run(
      "ui-slop/gradient-text",
      css(`
.icon {
  background: url("/icon.svg");
  -webkit-background-clip: text;
}
`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag a gradient background without background-clip:text", () => {
    const v = run(
      "ui-slop/gradient-text",
      css(`
.hero {
  background: linear-gradient(90deg, #7c3aed, #06b6d4);
}
`),
    );
    expect(v).toHaveLength(0);
  });

  it("only applies to style files (skipped for prose)", () => {
    const rule = findRule("ui-slop/gradient-text");
    expect(rule.appliesTo({ path: "README.md", text: "", kind: "prose" })).toBe(false);
  });
});

describe("ui-slop/ai-color-palette", () => {
  it("flags a linear-gradient with purple + cyan stops (hex)", () => {
    const v = run(
      "ui-slop/ai-color-palette",
      css(`
.bg {
  background: linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%);
}
`),
    );
    expect(v).toHaveLength(1);
    expect(v[0].matched).toMatch(/linear-gradient/);
  });

  it("flags a radial-gradient with purple + cyan stops via hsl()", () => {
    const v = run(
      "ui-slop/ai-color-palette",
      css(`
.bg {
  background: radial-gradient(circle, hsl(270, 70%, 50%), hsl(185, 80%, 50%));
}
`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag a gradient with two warm colors (negative)", () => {
    const v = run(
      "ui-slop/ai-color-palette",
      css(`
.bg {
  background: linear-gradient(90deg, #f97316, #ef4444);
}
`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag a gradient with only purple stops (no cyan)", () => {
    const v = run(
      "ui-slop/ai-color-palette",
      css(`
.bg { background: linear-gradient(90deg, #7c3aed, #a855f7); }
`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag near-black or near-white hex (saturation/lightness guard)", () => {
    const v = run(
      "ui-slop/ai-color-palette",
      css(`
.bg { background: linear-gradient(90deg, #111111, #ffffff); }
`),
    );
    expect(v).toHaveLength(0);
  });
});

describe("ui-slop/animate-layout-properties", () => {
  it("flags @keyframes that animates width", () => {
    const v = run(
      "ui-slop/animate-layout-properties",
      css(`
@keyframes grow {
  from { width: 100px; }
  to { width: 200px; }
}
`),
    );
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].matched).toMatch(/width\s*:\s*100px/);
  });

  it("flags transition: width", () => {
    const v = run(
      "ui-slop/animate-layout-properties",
      css(`
.panel { transition: width 0.3s ease; }
`),
    );
    expect(v).toHaveLength(1);
    expect(v[0].matched).toMatch(/transition\s*:\s*width/);
  });

  it("flags transition-property: height", () => {
    const v = run(
      "ui-slop/animate-layout-properties",
      css(`
.panel { transition-property: height; }
`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag transition: transform / opacity (negative)", () => {
    const v = run(
      "ui-slop/animate-layout-properties",
      css(`
.panel { transition: transform 0.3s, opacity 0.2s; }
@keyframes fade {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag a static width declaration outside @keyframes", () => {
    const v = run(
      "ui-slop/animate-layout-properties",
      css(`
.box { width: 200px; height: 100px; padding: 12px; }
`),
    );
    expect(v).toHaveLength(0);
  });
});

describe("ui-slop/skipped-heading-levels", () => {
  it("flags h1 → h3 in HTML", () => {
    const v = run(
      "ui-slop/skipped-heading-levels",
      markup(`
<section>
  <h1>Title</h1>
  <h3>Subtitle</h3>
</section>
`),
    );
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/h1 to h3/);
  });

  it("flags h1 → h4 in JSX", () => {
    const v = run(
      "ui-slop/skipped-heading-levels",
      tsx(`
export function Page() {
  return (
    <div>
      <h1>Title</h1>
      <h4>Deep section</h4>
    </div>
  );
}
`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag h1 → h2 → h3 (proper hierarchy)", () => {
    const v = run(
      "ui-slop/skipped-heading-levels",
      markup(`<h1>a</h1><h2>b</h2><h3>c</h3>`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag h3 → h1 (going up a level is fine)", () => {
    const v = run(
      "ui-slop/skipped-heading-levels",
      markup(`<h1>a</h1><h2>b</h2><h3>c</h3><h1>d</h1><h2>e</h2>`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not apply to a .ts file (no JSX)", () => {
    const rule = findRule("ui-slop/skipped-heading-levels");
    expect(rule.appliesTo({ path: "lib.ts", text: "<h1></h1><h3></h3>", kind: "code" })).toBe(false);
  });
});

describe("ui-slop/monospace-everywhere", () => {
  it("is default-off but flags monospace font-family on body when invoked", () => {
    const rule = findRule("ui-slop/monospace-everywhere");
    expect(rule.enabledByDefault).toBe(false);
    expect(rule.defaultSeverity).toBe("info");
    const v = run(
      "ui-slop/monospace-everywhere",
      css(`
body {
  font-family: "JetBrains Mono", Menlo, monospace;
}
`),
    );
    expect(v).toHaveLength(1);
  });

  it("flags :root with monospace-only font stack", () => {
    const v = run(
      "ui-slop/monospace-everywhere",
      css(`:root { font-family: "Fira Code", Consolas, monospace; }`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag a body font-family that includes a non-monospace fallback (negative)", () => {
    const v = run(
      "ui-slop/monospace-everywhere",
      css(`body { font-family: "Inter", system-ui, monospace; }`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag monospace font-family on a non-top-level selector", () => {
    const v = run(
      "ui-slop/monospace-everywhere",
      css(`code { font-family: "JetBrains Mono", monospace; }`),
    );
    expect(v).toHaveLength(0);
  });
});

describe("ui-slop/flat-type-hierarchy", () => {
  it("is default-off but flags 3+ font-sizes with ratio < 1.125 when invoked", () => {
    const rule = findRule("ui-slop/flat-type-hierarchy");
    expect(rule.enabledByDefault).toBe(false);
    expect(rule.defaultSeverity).toBe("info");
    const v = run(
      "ui-slop/flat-type-hierarchy",
      css(`
.h1 { font-size: 16px; }
.h2 { font-size: 17px; }
.h3 { font-size: 18px; }
`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag a clear hierarchy with healthy ratios (negative)", () => {
    const v = run(
      "ui-slop/flat-type-hierarchy",
      css(`
.h1 { font-size: 14px; }
.h2 { font-size: 18px; }
.h3 { font-size: 24px; }
.h4 { font-size: 32px; }
`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag a stylesheet with fewer than 3 distinct font-sizes", () => {
    const v = run(
      "ui-slop/flat-type-hierarchy",
      css(`
.a { font-size: 14px; }
.b { font-size: 14px; }
.c { font-size: 18px; }
`),
    );
    expect(v).toHaveLength(0);
  });
});

describe("ui-slop pack metadata", () => {
  it("registers exactly six rules", () => {
    expect(uiSlopPack.rules.map((r) => r.id).sort()).toEqual(
      [
        "ui-slop/ai-color-palette",
        "ui-slop/animate-layout-properties",
        "ui-slop/flat-type-hierarchy",
        "ui-slop/gradient-text",
        "ui-slop/monospace-everywhere",
        "ui-slop/skipped-heading-levels",
      ].sort(),
    );
  });

  it("default-on rules are exactly the four spec rules", () => {
    const onByDefault = uiSlopPack.rules.filter((r) => r.enabledByDefault).map((r) => r.id);
    expect(onByDefault.sort()).toEqual(
      [
        "ui-slop/gradient-text",
        "ui-slop/ai-color-palette",
        "ui-slop/animate-layout-properties",
        "ui-slop/skipped-heading-levels",
      ].sort(),
    );
  });

  it("default-off rules are exactly the two spec rules with severity info", () => {
    const offByDefault = uiSlopPack.rules.filter((r) => !r.enabledByDefault);
    expect(offByDefault.map((r) => r.id).sort()).toEqual(
      ["ui-slop/flat-type-hierarchy", "ui-slop/monospace-everywhere"].sort(),
    );
    for (const r of offByDefault) {
      expect(r.defaultSeverity).toBe("info");
    }
  });
});
