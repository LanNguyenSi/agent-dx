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
    "placement-slop": false,
    "workflow-slop": false,
    "review-slop": false,
  },
  ruleOverrides: {},
  ignorePaths: [],
  treatAsProse: [],
  treatAsCode: [],
  entrypointGlobs: [],
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
    expect(rule.appliesTo({ path: "README.md", text: "", kind: "prose" })).toBe(
      false,
    );
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

  it("flags transition: all (blanket transition is the biggest layout-trash offender)", () => {
    const v = run(
      "ui-slop/animate-layout-properties",
      css(`.panel { transition: all 0.3s ease; }`),
    );
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/transition: all/);
  });

  it("flags a width animation inside minified single-line CSS", () => {
    const v = run(
      "ui-slop/animate-layout-properties",
      css(`@keyframes g{from{width:100px}to{width:200px}}`),
    );
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].line).toBe(1);
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
    expect(
      rule.appliesTo({
        path: "lib.ts",
        text: "<h1></h1><h3></h3>",
        kind: "code",
      }),
    ).toBe(false);
  });

  it("does NOT flag PascalCase React component tags (<H1> <H3>)", () => {
    // PascalCase tags are React components, not HTML headings.
    const v = run(
      "ui-slop/skipped-heading-levels",
      tsx(`
import { H1, H3 } from "./typography";
export function Page() {
  return (<div><H1>Title</H1><H3>Sub</H3></div>);
}
`),
    );
    expect(v).toHaveLength(0);
  });

  it("flags a self-closing skip pattern (<h1 /><h3 />)", () => {
    const v = run(
      "ui-slop/skipped-heading-levels",
      markup(`<section><h1 /><h3 /></section>`),
    );
    expect(v).toHaveLength(1);
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

  it("does not flag when only ONE consecutive ratio is below 1.125 (mixed scale)", () => {
    // 8 → 16 is a 2× jump (healthy); 16 → 17 → 18 are close. The scale as
    // a whole is not flat, so the rule should stay quiet.
    const v = run(
      "ui-slop/flat-type-hierarchy",
      css(`
.a { font-size: 8px; }
.b { font-size: 16px; }
.c { font-size: 17px; }
.d { font-size: 18px; }
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
        "ui-slop/focus-outline-removed",
        "ui-slop/viewport-zoom-disabled",
        "ui-slop/img-missing-alt",
        "ui-slop/lorem-ipsum-placeholder",
      ].sort(),
    );
  });

  it("default-on rules are the four spec rules plus the four accessibility and placeholder rules", () => {
    const onByDefault = uiSlopPack.rules
      .filter((r) => r.enabledByDefault)
      .map((r) => r.id);
    expect(onByDefault.sort()).toEqual(
      [
        "ui-slop/gradient-text",
        "ui-slop/ai-color-palette",
        "ui-slop/animate-layout-properties",
        "ui-slop/skipped-heading-levels",
        "ui-slop/focus-outline-removed",
        "ui-slop/viewport-zoom-disabled",
        "ui-slop/img-missing-alt",
        "ui-slop/lorem-ipsum-placeholder",
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

describe("ui-slop/focus-outline-removed", () => {
  const id = "ui-slop/focus-outline-removed";

  it("flags outline:none on :focus with no replacement", () => {
    const v = run(id, css(`button:focus { outline: none; color: red; }`));
    expect(v).toHaveLength(1);
    expect(v[0].matched).toBe("outline: none");
  });

  it("flags outline:0 on :focus-visible", () => {
    expect(run(id, css(`a:focus-visible { outline: 0; }`))).toHaveLength(1);
  });

  it("allows a box-shadow replacement", () => {
    expect(
      run(
        id,
        css(`input:focus { outline: none; box-shadow: 0 0 0 2px blue; }`),
      ),
    ).toEqual([]);
  });

  it("allows the :focus:not(:focus-visible) pattern", () => {
    expect(
      run(id, css(`button:focus:not(:focus-visible) { outline: none; }`)),
    ).toEqual([]);
  });

  it("ignores outline:none on a non-focus selector", () => {
    expect(run(id, css(`.card { outline: none; }`))).toEqual([]);
  });

  it("ignores a visible outline on :focus", () => {
    expect(run(id, css(`a:focus { outline: 2px solid blue; }`))).toEqual([]);
  });
});

describe("ui-slop/viewport-zoom-disabled", () => {
  const id = "ui-slop/viewport-zoom-disabled";

  it("flags user-scalable=no", () => {
    const v = run(
      id,
      markup(
        `<meta name="viewport" content="width=device-width, user-scalable=no">`,
      ),
    );
    expect(v).toHaveLength(1);
    expect(v[0].matched).toBe("user-scalable=no");
  });

  it("flags maximum-scale=1 with content before name", () => {
    expect(
      run(
        id,
        markup(
          `<meta content="width=device-width, maximum-scale=1.0" name="viewport" />`,
        ),
      ),
    ).toHaveLength(1);
  });

  it("allows a plain responsive viewport", () => {
    expect(
      run(
        id,
        markup(
          `<meta name="viewport" content="width=device-width, initial-scale=1">`,
        ),
      ),
    ).toEqual([]);
  });

  it("allows maximum-scale above 1 and non-viewport meta", () => {
    expect(
      run(
        id,
        markup(
          `<meta name="viewport" content="width=device-width, maximum-scale=5">
<meta name="description" content="user-scalable=no is discussed here">`,
        ),
      ),
    ).toEqual([]);
  });
});

describe("ui-slop/img-missing-alt", () => {
  const id = "ui-slop/img-missing-alt";

  it("flags an img without alt", () => {
    const v = run(id, markup(`<img src="a.png">`));
    expect(v).toHaveLength(1);
  });

  it("flags a JSX img with an arrow function and no alt", () => {
    const v = run(id, tsx(`const x = <img src={s} onLoad={() => go()} />;`));
    expect(v).toHaveLength(1);
  });

  it("allows alt, empty alt, and a spread", () => {
    expect(
      run(id, markup(`<img src="a.png" alt="Logo"><img src="b.png" alt="">`)),
    ).toEqual([]);
    expect(run(id, tsx(`const x = <img {...props} />;`))).toEqual([]);
  });

  it("ignores components and similarly named tags", () => {
    expect(
      run(id, tsx(`const x = <Img src="a" />; const y = <imgx src="b" />;`)),
    ).toEqual([]);
  });
});

describe("ui-slop/lorem-ipsum-placeholder", () => {
  const id = "ui-slop/lorem-ipsum-placeholder";

  it("flags lorem ipsum once per file", () => {
    const v = run(
      id,
      markup(`<p>Lorem ipsum dolor sit amet</p><p>lorem ipsum again</p>`),
    );
    expect(v).toHaveLength(1);
    expect(v[0].matched).toBe("Lorem ipsum");
  });

  it("flags it in JSX", () => {
    expect(run(id, tsx(`const a = <p>Lorem  Ipsum</p>;`))).toHaveLength(1);
  });

  it("allows real copy", () => {
    expect(run(id, markup(`<p>Welcome to the dashboard</p>`))).toEqual([]);
  });
});
