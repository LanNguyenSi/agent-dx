/**
 * `bindings.log`: the append-only record of every binding change after a
 * spec became `proposed`.
 *
 * JSON lines: one object per line, each line ends in a line feed, no
 * carriage return anywhere, no blank line. Line 1 is the propose entry, which
 * names the commit `propose` ran at and the hash of the raw bytes of
 * `bindings.yaml` in that commit. Every later line is a bind entry: one TP ID
 * and its full new binding, plus the hash of the line before it, so a line
 * changed, removed, inserted or moved breaks the chain at the line after it.
 *
 * The parser is pure like every other format parser: text in, a result out.
 * It stops at the first problem, because every line after a break is
 * unanchored. A byte order mark at the start of the text is removed by the
 * reader, as for every file of a spec directory; `bind` never writes one.
 */
import { createHash } from "node:crypto";
import type { Binding, Bindings } from "./bindings.js";
import { validateBindings } from "./bindings.js";
import { MAX_INPUT_LENGTH, parseJsonText } from "./input.js";
import { COMMIT_RE, isRecord } from "./validate.js";

export const BINDINGS_LOG_FILE = "bindings.log";

export interface ProposeEntry {
  seq: 1;
  kind: "propose";
  /** The full id of the commit `propose` ran at (its HEAD). */
  commit: string;
  /** `sha256:<hex>` of the raw bytes of `bindings.yaml` in that commit. */
  bindings: string;
}

export interface BindEntry {
  seq: number;
  kind: "bind";
  tp: string;
  /** The full new binding of `tp`, in canonical form (see `canonicalBinding`). */
  binding: Binding;
  /** `sha256:<hex>` of the UTF-8 bytes of the previous line, without its line feed. */
  prev: string;
}

export interface BindingsLog {
  propose: ProposeEntry;
  binds: BindEntry[];
  /** The text of every line, without its line feed, in file order. */
  lines: string[];
}

export const LOG_PROBLEM_CODES = [
  "log-too-large",
  "log-empty",
  "log-line-ending",
  "log-blank-line",
  "log-not-json",
  "log-entry-shape",
  "log-propose-not-first",
  "log-seq",
  "log-chain",
] as const;
export type LogProblemCode = (typeof LOG_PROBLEM_CODES)[number];

export interface LogProblem {
  code: LogProblemCode;
  /** 1-based line of the problem; 0 for the text as a whole. */
  line: number;
  message: string;
}

export type LogParseResult =
  { ok: true; value: BindingsLog } | { ok: false; problem: LogProblem };

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const TP_ID_RE = /^TP-[1-9][0-9]{0,8}$/;

/** `sha256:<hex>` of a string's UTF-8 bytes, or of the bytes given. */
export function sha256Tag(data: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/**
 * The one spelling of a binding in the log and in a rewritten
 * `bindings.yaml`: `status`, then `selector`, `file`, `fixtures` and
 * `notes`, an absent optional field left out and `fixtures` always there.
 */
export function canonicalBinding(binding: Binding): Binding {
  return {
    status: binding.status,
    ...(binding.selector !== undefined ? { selector: binding.selector } : {}),
    ...(binding.file !== undefined ? { file: binding.file } : {}),
    fixtures: [...binding.fixtures],
    ...(binding.notes !== undefined ? { notes: binding.notes } : {}),
  };
}

/** Whether two parsed binding sets are equal: the same TP IDs, each with the same binding. */
export function sameBindings(a: Bindings, b: Bindings): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (JSON.stringify(keysA) !== JSON.stringify(keysB)) return false;
  return keysA.every(
    (key) =>
      JSON.stringify(canonicalBinding(a[key]!)) ===
      JSON.stringify(canonicalBinding(b[key]!)),
  );
}

/** The TP IDs whose binding differs between `a` and `b`, or that only one of them has, sorted. */
export function differingBindings(a: Bindings, b: Bindings): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((key) => {
    const x = a[key];
    const y = b[key];
    if (x === undefined || y === undefined) return true;
    return (
      JSON.stringify(canonicalBinding(x)) !==
      JSON.stringify(canonicalBinding(y))
    );
  });
}

/** The line of a propose entry, without a line feed. */
export function serializeProposeEntry(
  commit: string,
  bindingsHash: string,
): string {
  const entry: ProposeEntry = {
    seq: 1,
    kind: "propose",
    commit,
    bindings: bindingsHash,
  };
  return JSON.stringify(entry);
}

/** The line of the bind entry that follows `log`, without a line feed. */
export function serializeNextBind(
  log: BindingsLog,
  tp: string,
  binding: Binding,
): string {
  const entry: BindEntry = {
    seq: log.lines.length + 1,
    kind: "bind",
    tp,
    binding: canonicalBinding(binding),
    prev: sha256Tag(log.lines[log.lines.length - 1]!),
  };
  return JSON.stringify(entry);
}

/** `base` with every bind entry applied in order; the input is not changed. */
export function replayBindings(
  base: Bindings,
  binds: readonly BindEntry[],
): Bindings {
  const out: Bindings = { ...base };
  for (const entry of binds) out[entry.tp] = canonicalBinding(entry.binding);
  return out;
}

function problem(
  code: LogProblemCode,
  line: number,
  message: string,
): LogParseResult {
  return { ok: false, problem: { code, line, message } };
}

function exactKeys(
  rec: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(rec).sort();
  return JSON.stringify(own) === JSON.stringify([...keys].sort());
}

const PROPOSE_KEYS = ["seq", "kind", "commit", "bindings"] as const;
const BIND_KEYS = ["seq", "kind", "tp", "binding", "prev"] as const;

/** Parses the text of a `bindings.log`. */
export function parseBindingsLog(text: string): LogParseResult {
  if (text.length > MAX_INPUT_LENGTH) {
    return problem(
      "log-too-large",
      0,
      `bindings.log is ${text.length} characters, the limit is ${MAX_INPUT_LENGTH}`,
    );
  }
  if (text === "") return problem("log-empty", 0, "bindings.log is empty");
  const cr = text.indexOf("\r");
  if (cr >= 0) {
    return problem(
      "log-line-ending",
      text.slice(0, cr).split("\n").length,
      "bindings.log contains a carriage return; every line ends in a line feed only",
    );
  }
  if (!text.endsWith("\n")) {
    return problem(
      "log-line-ending",
      text.split("\n").length,
      "the last line of bindings.log does not end in a line feed",
    );
  }
  const lines = text.slice(0, -1).split("\n");
  let propose: ProposeEntry | undefined;
  const binds: BindEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i]!;
    if (line.trim() === "") {
      return problem("log-blank-line", n, `line ${n} of bindings.log is blank`);
    }
    const decoded = parseJsonText(line);
    if (!decoded.ok) {
      return problem(
        "log-not-json",
        n,
        `line ${n} of bindings.log is not one strict JSON object (${decoded.errors[0]!.code})`,
      );
    }
    const rec = decoded.value;
    if (!isRecord(rec)) {
      return problem(
        "log-entry-shape",
        n,
        `line ${n} of bindings.log is not a JSON object`,
      );
    }
    if (rec["seq"] !== n) {
      return problem(
        "log-seq",
        n,
        `line ${n} of bindings.log has seq ${JSON.stringify(rec["seq"])}; seq starts at 1 and grows by exactly 1 per line`,
      );
    }
    if (n === 1) {
      if (rec["kind"] !== "propose") {
        return problem(
          "log-propose-not-first",
          n,
          "line 1 of bindings.log is not the propose entry",
        );
      }
      if (
        !exactKeys(rec, PROPOSE_KEYS) ||
        typeof rec["commit"] !== "string" ||
        !COMMIT_RE.test(rec["commit"]) ||
        typeof rec["bindings"] !== "string" ||
        !HASH_RE.test(rec["bindings"])
      ) {
        return problem(
          "log-entry-shape",
          n,
          'line 1 of bindings.log must be exactly { "seq": 1, "kind": "propose", "commit": <full commit id>, "bindings": "sha256:<64 hex>" }',
        );
      }
      propose = {
        seq: 1,
        kind: "propose",
        commit: rec["commit"],
        bindings: rec["bindings"],
      };
      continue;
    }
    if (rec["kind"] === "propose") {
      return problem(
        "log-propose-not-first",
        n,
        `line ${n} of bindings.log is a second propose entry; there is exactly one, on line 1`,
      );
    }
    if (
      rec["kind"] !== "bind" ||
      !exactKeys(rec, BIND_KEYS) ||
      typeof rec["tp"] !== "string" ||
      !TP_ID_RE.test(rec["tp"]) ||
      typeof rec["prev"] !== "string" ||
      !HASH_RE.test(rec["prev"])
    ) {
      return problem(
        "log-entry-shape",
        n,
        `line ${n} of bindings.log must be exactly { "seq", "kind": "bind", "tp": <TP ID>, "binding": {...}, "prev": "sha256:<64 hex>" }`,
      );
    }
    const tp = rec["tp"];
    const parsed = validateBindings({ [tp]: rec["binding"] });
    const binding = parsed.ok ? parsed.value[tp] : undefined;
    if (
      binding === undefined ||
      JSON.stringify(canonicalBinding(binding)) !==
        JSON.stringify(rec["binding"])
    ) {
      return problem(
        "log-entry-shape",
        n,
        `line ${n} of bindings.log: the binding of ${tp} is not a valid binding in canonical form`,
      );
    }
    if (rec["prev"] !== sha256Tag(lines[i - 1]!)) {
      return problem(
        "log-chain",
        n,
        `line ${n} of bindings.log: prev is not the hash of line ${n - 1}; an earlier line was changed, removed, inserted or moved`,
      );
    }
    binds.push({ seq: n, kind: "bind", tp, binding, prev: rec["prev"] });
  }
  return { ok: true, value: { propose: propose!, binds, lines } };
}
