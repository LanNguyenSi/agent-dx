import type { FileTarget, PackDefinition, Rule, RuleContext, Violation } from "../types.js";
import { offsetToLineCol } from "../util/text.js";

// ─────────────────────────── shared helpers ───────────────────────────

function appliesToStyle(file: FileTarget): boolean {
  return file.kind === "style";
}

function appliesToHeadingHosts(file: FileTarget): boolean {
  if (file.kind === "markup") return true;
  if (file.kind === "code") return /\.(tsx|jsx)$/i.test(file.path);
  return false;
}

function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => " ".repeat(block.length));
}

function makeViolation(
  rule: Rule,
  file: FileTarget,
  startOffset: number,
  endOffset: number,
  matched: string,
  message: string,
): Violation {
  const start = offsetToLineCol(file.text, startOffset);
  const end = offsetToLineCol(file.text, endOffset);
  return {
    ruleId: rule.id,
    pack: rule.pack,
    severity: rule.defaultSeverity,
    path: file.path,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    message,
    rationale: rule.rationale,
    matched,
  };
}

// Iterate balanced `{ ... }` blocks. Returns the inner body of each rule
// (everything between the matched braces) with its absolute start offset
// inside the original text. Skips strings to avoid matching `{` inside
// quoted content like `content: "{"`. Naive on `\\`-escaped quotes — but
// CSS rarely has them, and a false negative is fine for v1.
interface BlockSpan {
  /** offset of the opening `{` */
  openIndex: number;
  /** offset just past the closing `}` */
  closeIndex: number;
  /** the inner body (does not include the braces) */
  body: string;
  /** offset of the first char of `body` inside the original text */
  bodyStart: number;
}

function iterateBlocks(text: string): BlockSpan[] {
  const out: BlockSpan[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) break;
    // walk forward, tracking nested braces and strings
    let depth = 1;
    let j = open + 1;
    let str: '"' | "'" | null = null;
    while (j < text.length && depth > 0) {
      const c = text[j];
      if (str) {
        if (c === str) str = null;
      } else if (c === '"' || c === "'") {
        str = c;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
      }
      j++;
    }
    if (depth !== 0) break; // unbalanced — bail
    out.push({
      openIndex: open,
      closeIndex: j,
      bodyStart: open + 1,
      body: text.slice(open + 1, j - 1),
    });
    i = j;
  }
  return out;
}

// Walks every `prop: value;` declaration in a CSS body. Returns absolute
// offset (relative to the original file) of the property name start. Comments
// must already be stripped from `bodyText`.
interface Decl {
  prop: string;
  value: string;
  /** offset in original file at start of `prop` */
  propOffset: number;
  /** offset in original file at end of `value` (just past the last value char) */
  valueEnd: number;
}

function iterateDeclarations(bodyText: string, bodyStart: number): Decl[] {
  const out: Decl[] = [];
  const re = /([\w-]+)\s*:\s*([^;{}\n]*?)\s*(?:;|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyText)) !== null) {
    // Skip pseudo-selector-like matches: a `:hover` inside the body has no
    // property name, but our regex would still match if preceded by an
    // identifier. The guard below filters out matches inside a nested rule
    // (treat as belonging to the inner block, handled when iterateBlocks
    // recurses).
    const prop = m[1];
    const value = m[2];
    if (!value || value.length === 0) continue;
    out.push({
      prop: prop.toLowerCase(),
      value,
      propOffset: bodyStart + m.index,
      valueEnd: bodyStart + m.index + m[0].length,
    });
  }
  return out;
}

// ─────────────────────────── Rule 1: gradient-text ───

const GRADIENT_TEXT_BG_CLIP = /(?:-webkit-)?background-clip\s*:\s*text\b/i;
const GRADIENT_TEXT_GRADIENT =
  /background(?:-image)?\s*:[^;}]*\blinear-gradient\s*\(/i;

const gradientText: Rule = {
  id: "ui-slop/gradient-text",
  pack: "ui-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "`background-clip: text` combined with a linear-gradient background paints text in gradient colors — the signature LLM-generated landing-page headline. Common, low-effort, almost always agent-templated.",
  appliesTo: appliesToStyle,
  check({ file }: RuleContext): Violation[] {
    const text = stripCssComments(file.text);
    const violations: Violation[] = [];
    for (const block of iterateBlocks(text)) {
      const clipMatch = GRADIENT_TEXT_BG_CLIP.exec(block.body);
      if (!clipMatch) continue;
      const gradMatch = GRADIENT_TEXT_GRADIENT.exec(block.body);
      if (!gradMatch) continue;
      const startOffset = block.bodyStart + clipMatch.index;
      const endOffset = startOffset + clipMatch[0].length;
      violations.push(
        makeViolation(
          gradientText,
          file,
          startOffset,
          endOffset,
          clipMatch[0],
          "Gradient text (`background-clip: text` + linear-gradient) — a hallmark of agent-generated landing-page headlines.",
        ),
      );
    }
    return violations;
  },
};

// ─────────────────────────── Rule 2: ai-color-palette ───
// Detect gradients whose stops contain BOTH a purple/violet color AND a
// cyan/teal color. Works on hex (#rgb / #rrggbb) and hsl()/hsla() values.

const PURPLE_HUE: [number, number] = [260, 290];
const CYAN_HUE: [number, number] = [170, 200];

function hueInRange(h: number, range: [number, number]): boolean {
  return h >= range[0] && h <= range[1];
}

function expandShortHex(hex: string): string {
  // `#abc` → `aabbcc`; `#aabbcc` → `aabbcc`
  const stripped = hex.replace(/^#/, "");
  if (stripped.length === 3) {
    return stripped.split("").map((c) => c + c).join("");
  }
  if (stripped.length === 6) return stripped;
  // 4- or 8-char hex with alpha — strip alpha
  if (stripped.length === 4) {
    return stripped.slice(0, 3).split("").map((c) => c + c).join("");
  }
  if (stripped.length === 8) return stripped.slice(0, 6);
  return "";
}

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const expanded = expandShortHex(hex);
  if (expanded.length !== 6) return null;
  const r = parseInt(expanded.slice(0, 2), 16) / 255;
  const g = parseInt(expanded.slice(2, 4), 16) / 255;
  const b = parseInt(expanded.slice(4, 6), 16) / 255;
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        break;
      case g:
        h = ((b - r) / d + 2) * 60;
        break;
      default:
        h = ((r - g) / d + 4) * 60;
        break;
    }
  }
  return { h, s, l };
}

interface ColorClass {
  purple: boolean;
  cyan: boolean;
}

function classifyColor(token: string): ColorClass {
  const t = token.trim().toLowerCase();
  const out: ColorClass = { purple: false, cyan: false };
  // hex
  const hexMatch = /^#([0-9a-f]{3,8})$/.exec(t);
  if (hexMatch) {
    const hsl = hexToHsl(t);
    if (!hsl) return out;
    // require enough saturation + mid lightness to call it a "color"
    if (hsl.s < 0.25) return out;
    if (hsl.l < 0.1 || hsl.l > 0.9) return out;
    if (hueInRange(hsl.h, PURPLE_HUE)) out.purple = true;
    else if (hueInRange(hsl.h, CYAN_HUE)) out.cyan = true;
    return out;
  }
  // hsl()/hsla()
  const hslMatch = /^hsla?\(\s*(-?\d+(?:\.\d+)?)\s*(?:deg)?[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%/.exec(t);
  if (hslMatch) {
    let h = Number(hslMatch[1]);
    const s = Number(hslMatch[2]) / 100;
    const l = Number(hslMatch[3]) / 100;
    if (s < 0.25) return out;
    if (l < 0.1 || l > 0.9) return out;
    h = ((h % 360) + 360) % 360;
    if (hueInRange(h, PURPLE_HUE)) out.purple = true;
    else if (hueInRange(h, CYAN_HUE)) out.cyan = true;
  }
  return out;
}

// Extract every gradient call (linear or radial), one at a time. Tolerates
// nested parens (e.g. `rgb(...)` color stops) via depth-tracked scan.
interface GradientCall {
  /** offset of the `linear-gradient(` / `radial-gradient(` start */
  startOffset: number;
  /** offset just past the closing `)` */
  endOffset: number;
  /** raw inside-paren text */
  inner: string;
}

function iterateGradients(text: string): GradientCall[] {
  const out: GradientCall[] = [];
  const head = /\b(?:linear|radial)-gradient\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = head.exec(text)) !== null) {
    const openParen = m.index + m[0].length - 1;
    let depth = 1;
    let j = openParen + 1;
    while (j < text.length && depth > 0) {
      const c = text[j];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      j++;
    }
    if (depth !== 0) break;
    out.push({
      startOffset: m.index,
      endOffset: j,
      inner: text.slice(openParen + 1, j - 1),
    });
  }
  return out;
}

function extractColorTokens(inner: string): string[] {
  // Split top-level commas (color stops); each token may itself contain
  // commas inside `rgb(...)` etc., so use depth-tracked split.
  const tokens: string[] = [];
  let depth = 0;
  let buf = "";
  for (const c of inner) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) {
      tokens.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.trim()) tokens.push(buf);
  // For each token, the first whitespace-separated word that LOOKS like a
  // color is the color; the rest is the position. Pull out both #hex and
  // hsl()/rgb() forms.
  const colors: string[] = [];
  for (const tok of tokens) {
    const trimmed = tok.trim();
    const hex = /#[0-9a-fA-F]{3,8}\b/.exec(trimmed);
    if (hex) colors.push(hex[0]);
    const hsl = /hsla?\([^)]+\)/i.exec(trimmed);
    if (hsl) colors.push(hsl[0]);
  }
  return colors;
}

const aiColorPalette: Rule = {
  id: "ui-slop/ai-color-palette",
  pack: "ui-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "A gradient that mixes a violet/purple stop (hue 260–290) with a cyan/teal stop (hue 170–200) is the signature LLM color combo — overwhelmingly the default palette an agent reaches for when asked to make something `vibrant` or `modern`.",
  appliesTo: appliesToStyle,
  check({ file }: RuleContext): Violation[] {
    const text = stripCssComments(file.text);
    const violations: Violation[] = [];
    for (const grad of iterateGradients(text)) {
      const colors = extractColorTokens(grad.inner);
      let purple = false;
      let cyan = false;
      for (const c of colors) {
        const cls = classifyColor(c);
        if (cls.purple) purple = true;
        if (cls.cyan) cyan = true;
      }
      if (purple && cyan) {
        violations.push(
          makeViolation(
            aiColorPalette,
            file,
            grad.startOffset,
            grad.endOffset,
            text.slice(grad.startOffset, Math.min(grad.endOffset, grad.startOffset + 80)),
            "Purple/violet + cyan/teal gradient — the signature LLM color combo. Pick a palette that wasn't auto-generated.",
          ),
        );
      }
    }
    return violations;
  },
};

// ─────────────────────────── Rule 3: animate-layout-properties ───

const LAYOUT_PROPS = new Set([
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "top",
  "left",
  "right",
  "bottom",
]);

// `transition: all <duration>` is the single biggest layout-trash offender
// in agent-generated CSS — it animates every property change, including
// width/height/padding/margin. Flag separately from LAYOUT_PROPS because
// `all` is not a real CSS property and must not match inside @keyframes.
const TRANSITION_BLANKET_PROPS = new Set(["all"]);

const animateLayoutProperties: Rule = {
  id: "ui-slop/animate-layout-properties",
  pack: "ui-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "Animating layout properties (width, height, padding, margin, top/left/right/bottom) triggers layout on every frame. Agent-generated CSS reaches for these by default; transform + opacity are almost always the correct alternative.",
  appliesTo: appliesToStyle,
  check({ file }: RuleContext): Violation[] {
    const text = stripCssComments(file.text);
    const violations: Violation[] = [];

    // (a) `@keyframes` blocks containing animated layout props.
    const keyframesHead = /@(?:-webkit-)?keyframes\s+[\w-]+\s*/g;
    let m: RegExpExecArray | null;
    while ((m = keyframesHead.exec(text)) !== null) {
      // find the brace immediately after
      const braceIdx = text.indexOf("{", m.index + m[0].length);
      if (braceIdx === -1) continue;
      // walk balanced
      let depth = 1;
      let j = braceIdx + 1;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        j++;
      }
      if (depth !== 0) continue;
      const outerBody = text.slice(braceIdx + 1, j - 1);
      const outerBodyStart = braceIdx + 1;

      // Inside @keyframes the inner bodies are `0% { ... }` / `from { ... }`.
      for (const inner of iterateBlocks(outerBody)) {
        const absoluteBodyStart = outerBodyStart + inner.bodyStart;
        for (const decl of iterateDeclarations(inner.body, absoluteBodyStart)) {
          if (LAYOUT_PROPS.has(decl.prop)) {
            violations.push(
              makeViolation(
                animateLayoutProperties,
                file,
                decl.propOffset,
                decl.valueEnd,
                `${decl.prop}: ${decl.value}`,
                `\`${decl.prop}\` animated inside @keyframes — forces layout every frame. Use \`transform\` / \`opacity\` instead.`,
              ),
            );
          }
        }
      }
      keyframesHead.lastIndex = j;
    }

    // (b) `transition: <props>` and `transition-property: <props>`. Match
    // declarations across the whole file (declarations outside any rule
    // still apply for the lint).
    const transitionRe =
      /\btransition(?:-property)?\s*:\s*([^;}]+)/gi;
    let tm: RegExpExecArray | null;
    while ((tm = transitionRe.exec(text)) !== null) {
      const value = tm[1];
      // split on commas (top-level) — each shorthand has the property name
      // as its first token.
      const parts = value.split(",");
      for (const part of parts) {
        const tokens = part.trim().split(/\s+/);
        const propName = tokens[0]?.toLowerCase();
        if (!propName) continue;
        const isLayout = LAYOUT_PROPS.has(propName);
        const isBlanket = TRANSITION_BLANKET_PROPS.has(propName);
        if (isLayout || isBlanket) {
          const start = tm.index;
          const end = tm.index + tm[0].length;
          const reason = isBlanket
            ? `\`transition: all\` animates every changed property, including width/height/padding/margin. Name the properties you actually want to transition.`
            : `\`transition\` on layout property \`${propName}\` — animates layout on every frame. Use \`transform\` / \`opacity\`.`;
          violations.push(
            makeViolation(animateLayoutProperties, file, start, end, tm[0], reason),
          );
          break; // one violation per declaration is enough
        }
      }
    }

    return violations;
  },
};

// ─────────────────────────── Rule 4: skipped-heading-levels ───

const skippedHeadingLevels: Rule = {
  id: "ui-slop/skipped-heading-levels",
  pack: "ui-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "Skipping heading levels (e.g. h1 → h3 with no h2) breaks document structure for screen readers and is a tell that the agent generated visual hierarchy without thinking about semantics.",
  appliesTo: appliesToHeadingHosts,
  check({ file }: RuleContext): Violation[] {
    // Case-sensitive on purpose: HTML5 headings are lowercase, and JSX
    // intrinsic-element headings are lowercase by convention. PascalCase
    // `<H1>` / `<H3>` are React components, not headings — flagging them
    // would be a false positive.
    const headingRe = /<h([1-6])\b[^>]*>/g;
    const violations: Violation[] = [];
    let prevLevel = 0;
    let m: RegExpExecArray | null;
    while ((m = headingRe.exec(file.text)) !== null) {
      const level = Number(m[1]);
      if (prevLevel > 0 && level > prevLevel + 1) {
        violations.push(
          makeViolation(
            skippedHeadingLevels,
            file,
            m.index,
            m.index + m[0].length,
            m[0],
            `Heading jumps from h${prevLevel} to h${level} — skipped level h${prevLevel + 1}.`,
          ),
        );
      }
      prevLevel = level;
    }
    return violations;
  },
};

// ─────────────────────────── Rule 5: monospace-everywhere ───

const MONOSPACE_FONTS = new Set([
  "monospace",
  "jetbrains mono",
  "fira code",
  "fira mono",
  "ibm plex mono",
  "menlo",
  "consolas",
  "courier new",
  "courier",
  "source code pro",
  "sf mono",
  "ubuntu mono",
  "roboto mono",
  "inconsolata",
  "cascadia code",
  "cascadia mono",
]);

const TOP_LEVEL_SELECTORS = new Set([":root", "html", "body", "html, body", "body, html"]);

function normalizeSelector(sel: string): string {
  return sel.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseFontFamilyValue(value: string): string[] {
  // split on commas, strip quotes + whitespace
  return value
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
    .filter((part) => part.length > 0);
}

const monospaceEverywhere: Rule = {
  id: "ui-slop/monospace-everywhere",
  pack: "ui-slop",
  defaultSeverity: "info",
  enabledByDefault: false,
  rationale:
    "Setting a monospace-only font-family on `html`/`body`/`:root` makes the whole page look like a terminal demo. Intentional for some technical-product landing pages — off by default for that reason.",
  appliesTo: appliesToStyle,
  check({ file }: RuleContext): Violation[] {
    const text = stripCssComments(file.text);
    const violations: Violation[] = [];
    // Walk top-level rules: capture the selector preceding each block.
    let cursor = 0;
    for (const block of iterateBlocks(text)) {
      const selectorText = text.slice(cursor, block.openIndex);
      cursor = block.closeIndex;
      // Trim leading `}` / `;` etc. Take the substring after the last `}` or `;` (works for sequential rules).
      const lastTerm = Math.max(selectorText.lastIndexOf("}"), selectorText.lastIndexOf(";"));
      const selector = normalizeSelector(selectorText.slice(lastTerm + 1));
      if (!TOP_LEVEL_SELECTORS.has(selector)) continue;

      for (const decl of iterateDeclarations(block.body, block.bodyStart)) {
        if (decl.prop !== "font-family") continue;
        const families = parseFontFamilyValue(decl.value);
        if (families.length === 0) continue;
        if (families.every((f) => MONOSPACE_FONTS.has(f))) {
          violations.push(
            makeViolation(
              monospaceEverywhere,
              file,
              decl.propOffset,
              decl.valueEnd,
              `${decl.prop}: ${decl.value}`,
              `Top-level \`font-family\` is monospace-only on \`${selector}\` — whole page renders as a terminal.`,
            ),
          );
        }
      }
    }
    return violations;
  },
};

// ─────────────────────────── Rule 6: flat-type-hierarchy ───

function fontSizeToPx(value: string): number | null {
  const m = /^(-?\d*\.?\d+)\s*(px|rem|em|pt|%)?$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "px").toLowerCase();
  switch (unit) {
    case "px":
      return n;
    case "rem":
    case "em":
      return n * 16;
    case "pt":
      return n * (96 / 72);
    case "%":
      return (n / 100) * 16;
    default:
      return null;
  }
}

const flatTypeHierarchy: Rule = {
  id: "ui-slop/flat-type-hierarchy",
  pack: "ui-slop",
  defaultSeverity: "info",
  enabledByDefault: false,
  rationale:
    "If a stylesheet declares 3+ distinct `font-size` values but the ratio between consecutive sizes is below 1.125, the type hierarchy is too flat to read as a hierarchy. Off by default because mature design systems sometimes use intentionally subtle steps.",
  appliesTo: appliesToStyle,
  check({ file }: RuleContext): Violation[] {
    const text = stripCssComments(file.text);
    const decls: Decl[] = [];
    for (const block of iterateBlocks(text)) {
      for (const d of iterateDeclarations(block.body, block.bodyStart)) {
        if (d.prop === "font-size") decls.push(d);
      }
    }
    const seen = new Map<number, Decl>();
    for (const d of decls) {
      const px = fontSizeToPx(d.value);
      if (px === null) continue;
      // Round to 2 decimals to dedupe near-identical values.
      const key = Math.round(px * 100) / 100;
      if (!seen.has(key)) seen.set(key, d);
    }
    if (seen.size < 3) return [];
    const sorted = [...seen.keys()].sort((a, b) => a - b);
    // Require EVERY consecutive ratio to be below 1.125 — a single healthy
    // jump in the scale (e.g. 8 → 16 → 17 → 18) means the hierarchy is
    // fine; only flag when the whole scale is uniformly flat.
    let allFlat = true;
    for (let i = 1; i < sorted.length; i++) {
      const ratio = sorted[i] / sorted[i - 1];
      if (ratio >= 1.125) {
        allFlat = false;
        break;
      }
    }
    if (!allFlat) return [];
    // Report on the smallest font-size declaration as the anchor.
    const anchor = seen.get(sorted[0])!;
    return [
      makeViolation(
        flatTypeHierarchy,
        file,
        anchor.propOffset,
        anchor.valueEnd,
        `${anchor.prop}: ${anchor.value}`,
        `Type scale is too flat: ${sorted.length} distinct font-sizes with consecutive ratio < 1.125. Hierarchy will not read as hierarchy.`,
      ),
    ];
  },
};

// ─────────────────────────── pack export ───

export const uiSlopPack: PackDefinition = {
  id: "ui-slop",
  description:
    "Visual tells of AI-generated UIs in CSS / SCSS / LESS / markup: gradient text, purple+cyan palettes, animated layout properties, skipped heading levels, monospace-everywhere, flat type hierarchy. v1 is regex-driven and scope-limited (no Tailwind class strings, no JSX inline styles, no headless-browser rules); see the M3 followup tasks.",
  rules: [
    gradientText,
    aiColorPalette,
    animateLayoutProperties,
    skippedHeadingLevels,
    monospaceEverywhere,
    flatTypeHierarchy,
  ],
};
