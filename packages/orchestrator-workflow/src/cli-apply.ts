import type { ResolveInitInputsParams } from "./cli-inputs.js";
import { detectHarnesses } from "./detect.js";
import type { Harness } from "./detect.js";
import type { Manifest } from "./init.js";
import type { HarnessRouting } from "./routing.js";

/** The subset of `apply`'s commander options that feed input resolution. */
export interface ApplyResolutionOptions {
  harness?: string;
  models?: string;
  profile?: string;
  opencodeProvider?: string;
  tiers?: boolean;
  routing?: HarnessRouting;
}

/**
 * Builds `apply`'s own `resolveInitInputs` params, pinning the sticky-branch
 * wiring so a future edit to the CLI action's call site cannot silently
 * widen a deliberately templates-only target: `stickyPreChecked` is always
 * a hardcoded `[]` here, never `chosenHarnesses` or `detected` (see
 * `ResolveInitInputsParams.stickyPreChecked`'s doc comment for why).
 * Kept in its own side-effect-free module (rather than inline in `cli.ts`,
 * which runs `program.parseAsync(process.argv)` on import) so it can be
 * unit-tested directly (`test/cli-apply.test.ts`) instead of only
 * indirectly exercised through a spawned CLI process, and so a reversion
 * here fails a targeted test instead of only the much larger
 * interactive-prompt suite (agent-tasks fe834823, fix round 3, review
 * finding 1). `stickyAnnotateDetected` is a fresh `detectHarnesses(targetDir)`
 * call, independent of `chosenHarnesses`: it only feeds the checkbox's
 * " (detected)" label (`ResolveInitInputsParams.stickyAnnotateDetected`),
 * never the pre-check itself.
 */
export function buildApplyInitInputs(
  targetDir: string,
  chosenHarnesses: Harness[],
  previous: Manifest,
  interactive: boolean,
  opts: ApplyResolutionOptions,
  previousIsRecordedManifest: boolean,
): ResolveInitInputsParams {
  return {
    detected: chosenHarnesses,
    stickyPreChecked: [],
    stickyAnnotateDetected: detectHarnesses(targetDir),
    interactive,
    previous,
    opts,
    previousIsRecordedManifest,
  };
}
