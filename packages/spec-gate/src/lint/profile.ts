/**
 * Which profile a run uses and why.
 *
 * `triage.json` decides, through the class its fields derive in memory
 * (the file is never written). The stored `class` is not read for the
 * choice: a stale one is a `triage-stale` error and must not pick a light
 * profile, and a current one repeats the derived class anyway.
 * `--profile` is only a fallback for a run without a usable
 * `triage.json`, and an error when it disagrees with one.
 *
 * | triage.json            | --profile | profile            | source  | findings          |
 * | ---------------------- | --------- | ------------------ | ------- | ----------------- |
 * | usable, class gives light or full | absent    | the triage profile | triage  | none         |
 * | usable, light or full  | equal     | the triage profile | triage  | none              |
 * | usable, light or full  | different | the triage profile | triage  | profile-mismatch  |
 * | usable, no profile     | any       | flag, else full    | flag or default | profile-no-spec |
 * | absent                 | given     | the flag           | flag    | none              |
 * | absent                 | absent    | full               | default | profile-default   |
 * | unparsable             | given     | the flag           | flag    | none (format)     |
 * | unparsable             | absent    | full               | default | none (format)     |
 *
 * A class that leads to no spec, or an unparsable file, already carries an
 * error of its own, so neither adds the default warning on top.
 */
import { deriveTriageClass, profileForClass } from "../triage/index.js";
import type { Loaded, Profile, ProfileSource, RuleFinding } from "./types.js";
import type { Triage } from "../formats/index.js";

export const TRIAGE_FILE = "triage.json";

/** The target of `profile-default`, as an `acks.yaml` entry names it. */
export const PROFILE_DEFAULT_TARGET = "triage";

export interface ProfileChoice {
  profile: Profile;
  source: ProfileSource;
  findings: { rule: string; finding: RuleFinding }[];
}

export function resolveProfile(
  triage: Loaded<Triage>,
  flag: Profile | undefined,
): ProfileChoice {
  const fallback = (): Pick<ProfileChoice, "profile" | "source"> =>
    flag !== undefined
      ? { profile: flag, source: "flag" }
      : { profile: "full", source: "default" };

  if (triage.state === "failed") {
    return { ...fallback(), findings: [] };
  }
  if (triage.state === "absent") {
    if (flag !== undefined) {
      return { profile: flag, source: "flag", findings: [] };
    }
    return {
      profile: "full",
      source: "default",
      findings: [
        {
          rule: "profile-default",
          finding: {
            file: TRIAGE_FILE,
            path: "$",
            id: PROFILE_DEFAULT_TARGET,
            message:
              "no triage.json and no --profile: the full profile is used",
          },
        },
      ],
    };
  }
  const derived = deriveTriageClass(triage.value).class;
  // The stored class is not trusted for the profile: a file whose class or
  // rule version has gone stale is an error (`triage-stale`) and must not
  // choose a light profile, so the profile always follows the class the
  // fields give in memory. A current file stores that very class, so a
  // clean run sees no difference.
  const cls = derived;
  const fromTriage = profileForClass(cls);
  if (fromTriage === null) {
    return {
      ...fallback(),
      findings: [
        {
          rule: "profile-no-spec",
          finding: {
            file: TRIAGE_FILE,
            path: "class",
            message: `triage class ${cls} leads to no spec, so there is nothing to lint`,
          },
        },
      ],
    };
  }
  const findings: ProfileChoice["findings"] = [];
  if (flag !== undefined && flag !== fromTriage) {
    findings.push({
      rule: "profile-mismatch",
      finding: {
        file: TRIAGE_FILE,
        path: "class",
        message: `--profile ${flag} disagrees with triage class ${cls}, which leads to the ${fromTriage} profile`,
      },
    });
  }
  return { profile: fromTriage, source: "triage", findings };
}
