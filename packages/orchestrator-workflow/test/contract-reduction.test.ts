import { expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

const contracts = readAsset("skill/references/contracts.md");

it("routes implementer execution to the workflow step 6 heading", () => {
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
  expect(workflow).toContain("6. **Delegate implementation.**");
});
