import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBE_DIR = path.join(__dirname, "..", "src", "probe");

/** Every module specifier a file imports from, relative or bare, `type`
 * keyword included: this guard treats a type-only import exactly like a
 * value import, since it is still a structural dependency on the layer
 * this test exists to keep one-directional, and a `type` import can
 * turn into a value import in a later edit with nothing here to catch
 * it if it were exempt from the start. Matches both `import ... from
 * "spec"` and `import ... from "spec"` split across lines (the `from`
 * clause always ends the statement), and the `export ... from "spec"`
 * form, which none of these four files currently use but which would
 * carry the same structural dependency if one ever did. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /\bfrom\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/** The last path segment of a relative `./x.js` or `../x.js` specifier,
 * without its extension; `undefined` for anything else (a bare package
 * specifier, `node:*`). */
function relativeModuleName(specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.basename(specifier);
  return base.endsWith(".js") ? base.slice(0, -".js".length) : undefined;
}

function importedProbeModules(fileName: string): Set<string> {
  const source = fs.readFileSync(path.join(PROBE_DIR, fileName), "utf8");
  const modules = new Set<string>();
  for (const specifier of importSpecifiers(source)) {
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

  it("the only import cycle among the four files is the documented, type-only index.ts <-> plan.ts one", () => {
    const index = importedProbeModules("index.ts");
    const plan = importedProbeModules("plan.ts");
    expect(index.has("plan")).toBe(true);
    expect(plan.has("index")).toBe(true);
    // Neither side of the documented cycle reaches into session/step/
    // setup from the wrong direction either: plan.ts sits beside
    // index.ts, not below it, so it must not depend on the three
    // layered modules at all.
    expect(
      [...plan].filter((m) => ["session", "step", "setup"].includes(m)),
    ).toEqual([]);
  });
});
