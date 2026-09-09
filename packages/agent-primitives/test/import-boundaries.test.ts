import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBE_DIR = path.join(__dirname, "..", "src", "probe");
const SRC_DIR = path.join(__dirname, "..", "src");

/** Every module specifier a file imports from, relative or bare, `type`
 * keyword included: this guard treats a type-only import exactly like a
 * value import, since it is still a structural dependency on the layer
 * this test exists to keep one-directional, and a `type` import can
 * turn into a value import in a later edit with nothing here to catch
 * it if it were exempt from the start. Read off the real TypeScript
 * AST rather than a regex over the source text, so it covers every
 * statement form that actually creates a module dependency: `import
 * ... from "spec"` (single- or multi-line), `export ... from "spec"`,
 * a bare side-effect `import "spec";`, and a dynamic `import("spec")`
 * or `await import("spec")`. Parsing the AST also means a `from
 * "..."` that only appears inside a comment or a string literal is
 * never mistaken for an import. */
function importSpecifiers(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push((node.arguments[0] as ts.StringLiteral).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** The last path segment of a relative `./x.js`, `./x.ts` or `../x.js`/
 * `../x.ts` specifier, without its extension; `undefined` for anything
 * else (a bare package specifier, `node:*`). An extensionless relative
 * specifier (`./index`) matches the same module its `.js`-suffixed form
 * (`./index.js`) would: both are the same file at build time, and the
 * guard must not miss one just because a source file omitted the
 * extension. A `.ts`-suffixed specifier (`./index.ts`) is normalised the
 * same way: TypeScript source never imports its own sibling by that
 * spelling in practice, but a forbidden import spelled that way must
 * still be caught rather than silently passing as a module named
 * "index.ts", which cannot match "index" and so would never be flagged
 * as the forbidden import it is. */
function relativeModuleName(specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.basename(specifier);
  if (base.endsWith(".js")) return base.slice(0, -".js".length);
  if (base.endsWith(".ts")) return base.slice(0, -".ts".length);
  return base;
}

/** True if every import/export declaration in `source` whose module
 * specifier resolves to `targetFileName`'s own module name is
 * type-only (`import type ...`, `import { type X } ...`, or
 * `export type ... from`); `false` if even one such declaration also
 * carries a value binding. Used only to check a documented, tolerated
 * import cycle stays inert at the type level, never to decide whether
 * the dependency exists at all (`importedProbeModules` already does
 * that). */
function typeOnlyImportsOf(
  source: string,
  fileName: string,
  targetFileName: string,
): boolean {
  const targetModule = path.basename(
    targetFileName,
    path.extname(targetFileName),
  );
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let sawMatchingDeclaration = false;
  let allTypeOnly = true;
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      relativeModuleName(node.moduleSpecifier.text) === targetModule
    ) {
      sawMatchingDeclaration = true;
      const clause = node.importClause;
      if (clause === undefined) {
        // A bare `import "spec";`: a side-effect import is a value
        // dependency, never type-only.
        allTypeOnly = false;
      } else if (!clause.isTypeOnly) {
        // The whole clause is not `import type ...`, so a bare default
        // binding (`import X from`) is a value import; a namespace
        // binding (`import * as X from`) is always a value import too
        // (TS has no per-binding `type` form for either). Only a named
        // binding can be type-only per element (`import { type X }`).
        if (clause.name !== undefined) allTypeOnly = false;
        const bindings = clause.namedBindings;
        if (bindings !== undefined) {
          if (ts.isNamespaceImport(bindings)) {
            allTypeOnly = false;
          } else if (!bindings.elements.every((el) => el.isTypeOnly)) {
            allTypeOnly = false;
          }
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      relativeModuleName(node.moduleSpecifier.text) === targetModule
    ) {
      sawMatchingDeclaration = true;
      const exportClause = node.exportClause;
      const namedAreTypeOnly =
        exportClause !== undefined &&
        ts.isNamedExports(exportClause) &&
        exportClause.elements.every((el) => el.isTypeOnly);
      if (!node.isTypeOnly && !namedAreTypeOnly) allTypeOnly = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sawMatchingDeclaration && allTypeOnly;
}

function importedProbeModules(fileName: string): Set<string> {
  const filePath = path.join(PROBE_DIR, fileName);
  const source = fs.readFileSync(filePath, "utf8");
  const modules = new Set<string>();
  for (const specifier of importSpecifiers(source, filePath)) {
    const name = relativeModuleName(specifier);
    if (name !== undefined) modules.add(name);
  }
  return modules;
}

/**
 * Pins the layering `index.ts`'s own docblock describes:
 * `session.ts <- step.ts <- setup.ts <- index.ts`. Each of the three
 * lower layers may be imported by anything above it, but must never
 * import back down from a layer above -- that would be a cycle this
 * package's build has so far avoided only by convention, with nothing
 * to fail a PR that reintroduces one.
 *
 * The one documented exception is `index.ts` <-> `plan.ts`: `plan.ts`
 * imports `ExpectVerdict`/`IsolationMode` (type-only) back from
 * `index.ts` for its own `PlanMutantSpec`/`ProbePlanOptions` shapes, and
 * `index.ts` imports `PlanMutantSpec` (type-only) back from `plan.ts`.
 * Both sides of that cycle are type-only, `plan.ts` is not one of the
 * three layered modules this guard governs, and untangling it would
 * mean either duplicating those two type aliases or moving them to a
 * fourth file neither module already depends on for no behavioral
 * gain -- so it is named here and left alone rather than silently
 * exempted by this test simply never looking at `plan.ts` at all.
 */
describe("probe module import boundaries", () => {
  it("session.ts imports none of step.ts, setup.ts, or index.ts", () => {
    const imported = importedProbeModules("session.ts");
    expect(
      [...imported].filter((m) => ["step", "setup", "index"].includes(m)),
    ).toEqual([]);
  });

  it("step.ts imports none of setup.ts or index.ts", () => {
    const imported = importedProbeModules("step.ts");
    expect([...imported].filter((m) => ["setup", "index"].includes(m))).toEqual(
      [],
    );
  });

  it("setup.ts imports none of step.ts or index.ts", () => {
    const imported = importedProbeModules("setup.ts");
    expect([...imported].filter((m) => ["step", "index"].includes(m))).toEqual(
      [],
    );
  });

  it("if the index.ts <-> plan.ts cycle exists, both sides of it are type-only", () => {
    const indexPath = path.join(PROBE_DIR, "index.ts");
    const planPath = path.join(PROBE_DIR, "plan.ts");
    const indexSource = fs.readFileSync(indexPath, "utf8");
    const planSource = fs.readFileSync(planPath, "utf8");
    const index = importedProbeModules("index.ts");
    const plan = importedProbeModules("plan.ts");
    // This test does not require the cycle to exist: it is a
    // documented, tolerated exception to the layering the other three
    // cases pin, not a guarantee. It only pins that IF both directions
    // are present, neither is a value import -- a type-only import can
    // never become a runtime dependency without an edit this guard
    // would then need to review anyway.
    if (index.has("plan") && plan.has("index")) {
      expect(typeOnlyImportsOf(indexSource, indexPath, "plan.ts")).toBe(true);
      expect(typeOnlyImportsOf(planSource, planPath, "index.ts")).toBe(true);
    }
    // Neither side of a plan.ts <-> index.ts cycle reaches into
    // session/step/setup from the wrong direction either: plan.ts sits
    // beside index.ts, not below it, so it must not depend on the
    // three layered modules at all, cycle or no cycle.
    expect(
      [...plan].filter((m) => ["session", "step", "setup"].includes(m)),
    ).toEqual([]);
  });
});

describe("relativeModuleName", () => {
  it("normalises a .ts relative specifier the same as .js and extensionless, so a forbidden import spelled ./index.ts is not missed", () => {
    expect(relativeModuleName("./index.ts")).toBe("index");
    expect(relativeModuleName("./index.js")).toBe("index");
    expect(relativeModuleName("./index")).toBe("index");
    expect(relativeModuleName("../index.ts")).toBe("index");
  });

  it("leaves a bare package specifier and a node: specifier unmatched, .ts suffix or not", () => {
    expect(relativeModuleName("some-package.ts")).toBeUndefined();
    expect(relativeModuleName("node:fs")).toBeUndefined();
  });

  it("end-to-end: a synthetic source importing a forbidden layer with a .ts specifier is caught the same as the .js and extensionless forms", () => {
    // Mirrors what `importedProbeModules` does against a real file, but
    // against an in-memory source so the fixture is test-only and never
    // touches `src/probe`'s real layering. Before the fix, a `.ts`
    // specifier's `relativeModuleName` was the un-stripped "index.ts",
    // which never matches "index" in the forbidden-module filter the
    // real describe block above uses -- so this forbidden import would
    // have silently passed the guard.
    const forbiddenSource = [
      'import { begin } from "./index.ts";',
      'import { helper } from "./index.js";',
      'import { other } from "./index";',
    ].join("\n");
    const fileName = path.join(PROBE_DIR, "session.ts");
    const modules = new Set<string>();
    for (const specifier of importSpecifiers(forbiddenSource, fileName)) {
      const name = relativeModuleName(specifier);
      if (name !== undefined) modules.add(name);
    }
    expect([...modules]).toEqual(["index"]);
    expect(
      [...modules].filter((m) => ["step", "setup", "index"].includes(m)),
    ).toEqual(["index"]);
  });
});

/** Every `.ts` file under `src/`, recursively, as an absolute path. */
function allSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...allSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("exec.ts's combinedOutput() is the ONLY place that joins a stdout tail and a stderr tail", () => {
  // `exec.ts`'s own docblock on `combinedOutput` claims five call sites
  // "can never drift into independently-maintained copies of the same
  // `${a}\n${b}` join" -- a claim only a structural guard can keep
  // honest. Matches the literal shape (a template literal interpolating
  // something containing "stdoutTail", then a literal newline, then an
  // interpolation containing "stderrTail") anywhere under `src/`, so a
  // future site that reintroduces the raw join instead of importing
  // `combinedOutput` is caught the same way `verify/index.ts:498` was:
  // it had drifted into exactly this raw join while `combinedOutput`'s
  // docblock already claimed it as one of the five converted sites.
  const RAW_JOIN_PATTERN =
    /\$\{[^}]*stdoutTail[^}]*\}\\n\$\{[^}]*stderrTail[^}]*\}/;

  it("no file outside exec.ts contains the raw `${...stdoutTail}\\n${...stderrTail}` join", () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles(SRC_DIR)) {
      if (path.basename(file) === "exec.ts") continue;
      const source = fs.readFileSync(file, "utf8");
      if (RAW_JOIN_PATTERN.test(source)) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("exec.ts itself still contains exactly the one raw join, inside combinedOutput()'s own definition (the pattern is not stale)", () => {
    const execSource = fs.readFileSync(path.join(SRC_DIR, "exec.ts"), "utf8");
    const matches = execSource.match(new RegExp(RAW_JOIN_PATTERN, "g")) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("exec.ts's reportedNoVerdict() and wasSignalKilled() are the ONLY place that spells out the no-verdict disjunction by hand", () => {
  // Before these two predicates existed, every call site spelled the
  // same disjunction out inline: `X.timedOut || X.exitCode === null`
  // (reportedNoVerdict's shape) and `!X.timedOut && X.exitCode ===
  // null` (wasSignalKilled's shape). `exec.ts`'s own docblock on
  // `reportedNoVerdict` claims "all of those sites must agree on what
  // 'no verdict' means instead of each spelling the disjunction out
  // again" -- a claim only a structural guard can keep honest. Matches
  // either hand-written form (any dotted-property prefix on both
  // `timedOut` and `exitCode`) anywhere under `src/`, so a future site
  // that reintroduces a hand-rolled copy instead of calling the shared
  // predicate is caught rather than silently drifting alongside it.
  // Neither form matches a call site (`reportedNoVerdict(x)`,
  // `wasSignalKilled(x)`): those spell neither `timedOut` nor
  // `exitCode` at all.
  const HAND_WRITTEN_DISJUNCTION_PATTERN =
    /(?:!\s*[\w.]*\btimedOut\b\s*&&\s*[\w.]*\bexitCode\b\s*===\s*null)|(?:[\w.]*\btimedOut\b\s*\|\|\s*[\w.]*\bexitCode\b\s*===\s*null)/;

  it("no file outside exec.ts contains a hand-written copy of either form", () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles(SRC_DIR)) {
      if (path.basename(file) === "exec.ts") continue;
      const source = fs.readFileSync(file, "utf8");
      if (HAND_WRITTEN_DISJUNCTION_PATTERN.test(source)) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("exec.ts itself still contains exactly the two forms, one inside each predicate's own definition (the pattern is not stale)", () => {
    const execSource = fs.readFileSync(path.join(SRC_DIR, "exec.ts"), "utf8");
    const matches =
      execSource.match(new RegExp(HAND_WRITTEN_DISJUNCTION_PATTERN, "g")) ?? [];
    expect(matches.length).toBe(2);
  });
});
