import { expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

const contracts = readAsset("skill/references/contracts.md");
const implementer = readAsset("agents/implementer.md");

it("routes implementer execution to step 6 and commit reporting to the installed prompt", () => {
  const start = contracts.indexOf("## Implementer output contract");
  const end = contracts.indexOf("## Reviewer output contract", start);
  const section = contracts.slice(start, end);

  const route = section.match(
    /\[evidence-and-probes\.md workflow step 6\]\(([^#)]+)#([^)]+)\)/,
  );
  expect(route).toBeTruthy();
  const [, targetPath, fragment] = route!;
  expect(targetPath).toBe("evidence-and-probes.md");
  expect(fragment).toBe("workflow");
  const workflow = readAsset(`skill/references/${targetPath}`);
  expect(workflow).toMatch(/^## Workflow$/m);
  expect(section.replace(/\s+/g, " ")).toContain(
    "For commit reporting, follow the installed implementer role prompt.",
  );
  expect(section.replace(/\s+/g, " ")).toContain(
    "Return the selected contract's YAML envelope.",
  );
  expect(workflow).toContain("6. **Delegate implementation.**");
  expect(workflow).toContain("The implementer replays each one");

  for (const rule of [
    "Verification plans, probe plans, and repeat tallies run in the foreground",
    "Report the full sha of every commit you produced on the task branch",
  ]) {
    expect(implementer).toContain(rule);
  }
});
