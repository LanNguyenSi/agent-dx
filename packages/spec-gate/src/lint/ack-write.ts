/**
 * `spec-gate lint-ack`: append one entry to `<spec-dir>/acks.yaml`.
 *
 * Every refusal is a returned message, never a partial write. The file is
 * replaced through a temporary file in the same directory, created
 * exclusively and renamed over `acks.yaml`, so a reader sees the old or the
 * new file whole. A link at `acks.yaml` or at the spec directory is refused,
 * and the permission bits of an existing file carry over (never setuid,
 * setgid or sticky).
 *
 * The existing text is kept byte for byte and the entry is appended after it
 * (with a line feed first when the file does not end in one). The result is
 * parsed again. A file that cannot take another item that way, such as a list
 * written in flow style (`[]`) or a document closed by an end marker, is
 * rewritten as a block list of its entries, which drops its comments. The
 * rewrite is parsed again as well, and nothing is written when either result
 * does not hold exactly the old entries plus the new one.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ACKS_FILE,
  ackTextProblem,
  parseAcks,
  serializeAck,
  type Ack,
} from "./acks.js";
import { readSpecFile } from "./files.js";
import { RULES, findRule } from "./registry.js";
import type { RuleDef } from "./types.js";

export type AckWriteResult =
  | { ok: true; file: string; entries: number; normalised: boolean }
  | { ok: false; message: string };

function refuse(message: string): AckWriteResult {
  return { ok: false, message: `lint-ack: ${message}` };
}

function sameAcks(a: readonly Ack[], b: readonly Ack[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function writeAck(
  specDir: string,
  rule: string,
  id: string,
  reason: string,
  rules: readonly RuleDef[] = RULES,
): AckWriteResult {
  const dir = path.resolve(specDir);
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(dir);
  } catch {
    return refuse(`${specDir} is not a directory`);
  }
  if (dirStat.isSymbolicLink()) {
    return refuse(`${specDir} is a symlink, refusing to write into it`);
  }
  if (!dirStat.isDirectory()) return refuse(`${specDir} is not a directory`);

  const def = findRule(rules, rule);
  if (def === undefined)
    return refuse(`${JSON.stringify(rule)} is not a known rule`);
  if (def.level !== "warning") {
    return refuse(
      `${rule} is an error rule; only warnings can be acknowledged`,
    );
  }
  if (!def.ackable) return refuse(`${rule} cannot be acknowledged`);
  const idProblem = ackTextProblem(id);
  if (idProblem !== null) return refuse(`id ${idProblem.text}`);
  const reasonProblem = ackTextProblem(reason);
  if (reasonProblem !== null) return refuse(`reason ${reasonProblem.text}`);

  const file = path.join(dir, ACKS_FILE);
  let existingMode: number | undefined;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      return refuse(`${ACKS_FILE} is a symlink, refusing to write it`);
    }
    // Only the permission bits: never setuid, setgid or sticky.
    existingMode = stat.mode & 0o777;
  } catch {
    // absent; the read below tells a missing file from an unreadable one
  }

  let existingText = "";
  let existing: Ack[] = [];
  if (existingMode !== undefined) {
    const read = readSpecFile(dir, ACKS_FILE);
    if (!read.ok) return refuse(read.message);
    const parsed = parseAcks(read.text);
    if (!parsed.ok) {
      const first = parsed.errors[0]!;
      return refuse(
        `${ACKS_FILE} is not valid (${first.code} at ${first.path}); fix it first`,
      );
    }
    existingText = read.text;
    existing = parsed.value;
  }
  if (existing.some((a) => a.rule === rule && a.id === id)) {
    return refuse(`${rule} for ${JSON.stringify(id)} is already acknowledged`);
  }

  const entry: Ack = { rule, id, reason };
  const expected = [...existing, entry];
  const holds = (candidate: string): boolean => {
    const parsed = parseAcks(candidate);
    return parsed.ok && sameAcks(parsed.value, expected);
  };
  const glue = existingText === "" || existingText.endsWith("\n") ? "" : "\n";
  let text = existingText + glue + serializeAck(entry);
  let normalised = false;
  if (!holds(text)) {
    text = expected.map(serializeAck).join("");
    normalised = true;
  }
  if (!holds(text)) {
    return refuse(
      `could not produce a valid ${ACKS_FILE}; nothing was written`,
    );
  }

  const temp = `${file}.tmp-${process.pid}`;
  let created = false;
  try {
    if (existingMode !== undefined) fs.accessSync(file, fs.constants.W_OK);
    // `wx`: never follow or reuse an existing path at the temporary name.
    fs.writeFileSync(temp, text, { flag: "wx" });
    created = true;
    if (existingMode !== undefined) fs.chmodSync(temp, existingMode);
    fs.renameSync(temp, file);
  } catch (err) {
    // Only delete the temporary path this run created; something else may
    // already sit at that name and must be left alone.
    if (created) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // the temporary file stays; the named failure below is what callers see
      }
    }
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    return refuse(`cannot write ${ACKS_FILE}: ${code}`);
  }
  return { ok: true, file, entries: expected.length, normalised };
}
