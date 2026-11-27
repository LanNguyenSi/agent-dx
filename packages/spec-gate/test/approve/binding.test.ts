/**
 * The binding rule as a pure function: which ranges bring a spec to the
 * state judged at the tip, over every pair of states, and how a commit's
 * spec is given its state.
 */
import { describe, expect, it } from "vitest";
import {
  SPEC_STANDINGS,
  arrives,
  standingOf,
  type SpecStanding,
} from "../../src/approve/index.js";

const TIP = "sha256:" + "a".repeat(64);
const OTHER = "sha256:" + "b".repeat(64);

describe("arrives", () => {
  /** Every start and end, with whether the state judged at the tip arrives. */
  const ROWS: [SpecStanding, SpecStanding, boolean][] = [
    ["absent", "absent", false],
    ["absent", "not-proposed", false],
    ["absent", "proposed-other", false],
    ["absent", "proposed-tip", true],
    ["not-proposed", "absent", false],
    ["not-proposed", "not-proposed", false],
    ["not-proposed", "proposed-other", false],
    ["not-proposed", "proposed-tip", true],
    ["proposed-other", "absent", false],
    ["proposed-other", "not-proposed", false],
    ["proposed-other", "proposed-other", false],
    ["proposed-other", "proposed-tip", true],
    ["proposed-tip", "absent", false],
    ["proposed-tip", "not-proposed", false],
    ["proposed-tip", "proposed-other", false],
    ["proposed-tip", "proposed-tip", false],
  ];

  it("the table holds every pair of states once", () => {
    expect(SPEC_STANDINGS).toEqual([
      "absent",
      "not-proposed",
      "proposed-other",
      "proposed-tip",
    ]);
    const pairs = ROWS.map(([start, end]) => `${start} ${end}`);
    expect(new Set(pairs).size).toBe(16);
    for (const start of SPEC_STANDINGS) {
      for (const end of SPEC_STANDINGS) {
        expect(pairs).toContain(`${start} ${end}`);
      }
    }
    // Three of the sixteen arrive: every other start, into the tip's state.
    expect(ROWS.filter(([, , yes]) => yes)).toHaveLength(3);
  });

  it.each(ROWS)("from %s to %s: %s", (start, end, expected) => {
    expect(arrives(start, end)).toBe(expected);
  });
});

describe("standingOf", () => {
  it.each<
    [
      string,
      { status: string } | null,
      string | null,
      string | null,
      SpecStanding,
    ]
  >([
    ["no spec that parses", null, null, TIP, "absent"],
    ["no spec that parses, though a digest is given", null, TIP, TIP, "absent"],
    ["a draft", { status: "draft" }, TIP, TIP, "not-proposed"],
    [
      "a draft without a digest",
      { status: "draft" },
      null,
      TIP,
      "not-proposed",
    ],
    [
      "a status the format does not know",
      { status: "approved" },
      TIP,
      TIP,
      "not-proposed",
    ],
    [
      "proposed with the digest at the tip",
      { status: "proposed" },
      TIP,
      TIP,
      "proposed-tip",
    ],
    [
      "proposed with another digest",
      { status: "proposed" },
      OTHER,
      TIP,
      "proposed-other",
    ],
    [
      "proposed without a digest",
      { status: "proposed" },
      null,
      TIP,
      "proposed-other",
    ],
    [
      "proposed, and the tip has no digest",
      { status: "proposed" },
      TIP,
      null,
      "proposed-other",
    ],
    [
      "proposed, and neither has a digest: nothing equals a missing digest",
      { status: "proposed" },
      null,
      null,
      "proposed-other",
    ],
  ])("%s", (_what, state, digest, tipDigest, expected) => {
    expect(standingOf(state, digest, tipDigest)).toBe(expected);
  });
});
