import type { Harness } from "./detect.js";
import type { Manifest } from "./init.js";
import type {
  InitResolutionOptions,
  ResolveInitInputsParams,
} from "./cli-inputs.js";

/**
 * Builds `init`'s own `resolveInitInputs` params. Mirrors
 * `buildApplyInitInputs` (`cli-apply.ts`): kept in its own side-effect-free
 * module, rather than inline in `cli.ts`'s action, so a future edit to the
 * call site cannot silently reintroduce a `stickyPreChecked` (or
 * `stickyAnnotateDetected`) override without a targeted test catching it.
 * `init`'s call site never overrides either field: the sticky branch must
 * fall back to `resolveInitInputs`'s own `stickyPreChecked ?? []` and
 * `stickyAnnotateDetected ?? detected` defaults (D-002, agent-dx 7669907c;
 * see `ResolveInitInputsParams.stickyPreChecked`'s doc comment for why),
 * exactly as `apply` does via its own hardcoded `[]`. Unlike
 * `buildApplyInitInputs`, this builder does not set those two fields at
 * all, since `init` has no analogue of `apply`'s already-resolved
 * `chosenHarnesses` to guard against; omitting them is what lets
 * `resolveInitInputs`'s defaults do the pinning.
 */
export function buildInitInitInputs(
  detected: Harness[],
  previous: Manifest | undefined,
  interactive: boolean,
  opts: InitResolutionOptions,
): ResolveInitInputsParams {
  return {
    detected,
    interactive,
    previous,
    opts,
    // `previous` here is `readInstalledManifest(targetDir)` (undefined, or
    // the target's own actually-recorded manifest), unlike `apply`'s
    // synthetic operator-defaults "floor" object: an empty harnesses array
    // is a real recorded `--harness none` install here.
    previousIsRecordedManifest: true,
  };
}
