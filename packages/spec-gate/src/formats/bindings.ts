/**
 * `bindings.yaml`: ties each test-plan row to a concrete test.
 *
 * The file is a YAML mapping from TP ID to a binding. Only `status` is
 * required; a manual row has no binding at all, and a static row has no
 * selector. The file is the one place an implementation workflow may edit
 * after the spec is proposed, so the parser refuses every normative
 * field here (`wrong-layer-field`) and every field without a layer
 * (`unknown-field`).
 *
 * `file` and every `fixtures` entry are repo-relative paths without a `..`
 * segment, not absolute and not starting with `-`.
 *
 * A `selector` is passed to a test runner later, as one argv element and
 * never through a shell. The parser therefore rejects a selector that is
 * empty, starts with `-`, or contains a control character
 * (`invalid-selector`).
 */
import type { ParseResult } from "./errors.js";
import { ErrorSink, failResult } from "./errors.js";
import { parseYamlText } from "./input.js";
import { BINDING_STATUSES, layerOf } from "./layers.js";
import type { BindingStatus } from "./layers.js";
import type { Rec } from "./validate.js";
import {
  describeType,
  enumValue,
  hasControlChars,
  hasOwn,
  isRecord,
  nonEmptyString,
  relativePath,
  stringList,
} from "./validate.js";

export interface Binding {
  status: BindingStatus;
  selector?: string;
  file?: string;
  /** Defaults to an empty list. */
  fixtures: string[];
  notes?: string;
}

/** TP ID to binding, in file order. */
export type Bindings = Record<string, Binding>;

const TP_ID_RE = /^TP-[1-9][0-9]{0,8}$/;

/** True for a selector the runner may substitute into an argv element. */
export function isSafeSelector(selector: string): boolean {
  return (
    selector.trim() !== "" &&
    !selector.startsWith("-") &&
    !hasControlChars(selector)
  );
}

function parseBinding(
  sink: ErrorSink,
  tpId: string,
  raw: unknown,
): Binding | undefined {
  const before = sink.errors.length;
  const rowName = `binding ${tpId}`;
  if (!isRecord(raw)) {
    sink.add(
      "wrong-type",
      tpId,
      `${rowName} must be a mapping, got ${describeType(raw)}`,
    );
    return undefined;
  }
  const rec: Rec = raw;
  for (const field of Object.keys(rec)) {
    const layer = layerOf(field);
    if (layer === undefined) {
      sink.add(
        "unknown-field",
        `${tpId}.${field}`,
        `${rowName}: field ${JSON.stringify(field)} has no layer`,
      );
    } else if (layer === "normative") {
      sink.add(
        "wrong-layer-field",
        `${tpId}.${field}`,
        `${rowName}: field ${JSON.stringify(field)} is normative and belongs in testplan.yaml`,
      );
    }
  }
  if (!hasOwn(rec, "status")) {
    sink.add(
      "missing-field",
      `${tpId}.status`,
      `${rowName} is missing required field status`,
    );
  }
  const out: Partial<Binding> = {};
  if (hasOwn(rec, "status")) {
    const v = enumValue(
      sink,
      rec["status"],
      BINDING_STATUSES,
      `${tpId}.status`,
      `${rowName}: status`,
    );
    if (v !== undefined) out.status = v;
  }
  if (hasOwn(rec, "selector")) {
    const v = nonEmptyString(
      sink,
      rec["selector"],
      `${tpId}.selector`,
      `${rowName}: selector`,
    );
    if (v !== undefined) {
      if (isSafeSelector(v)) out.selector = v;
      else {
        sink.add(
          "invalid-selector",
          `${tpId}.selector`,
          `${rowName}: selector must not start with '-' or contain control characters`,
        );
      }
    }
  }
  if (hasOwn(rec, "file")) {
    const v = relativePath(
      sink,
      rec["file"],
      `${tpId}.file`,
      `${rowName}: file`,
    );
    if (v !== undefined) {
      if (v.startsWith("-")) {
        sink.add(
          "invalid-value",
          `${tpId}.file`,
          `${rowName}: file must not start with '-'`,
        );
      } else out.file = v;
    }
  }
  let fixtures: string[] = [];
  if (hasOwn(rec, "fixtures")) {
    const v = stringList(
      sink,
      rec["fixtures"],
      `${tpId}.fixtures`,
      `${rowName}: fixtures`,
    );
    if (v !== undefined) {
      v.forEach((entry, i) => {
        const path = `${tpId}.fixtures[${i}]`;
        const checked = relativePath(sink, entry, path, `${rowName}: fixture`);
        if (checked?.startsWith("-")) {
          sink.add(
            "invalid-value",
            path,
            `${rowName}: fixture must not start with '-'`,
          );
        }
      });
      fixtures = v;
    }
  }
  if (hasOwn(rec, "notes")) {
    const v = nonEmptyString(
      sink,
      rec["notes"],
      `${tpId}.notes`,
      `${rowName}: notes`,
    );
    if (v !== undefined) out.notes = v;
  }
  if (sink.errors.length > before) return undefined;
  return { ...out, fixtures } as Binding;
}

/** Validates an already decoded `bindings.yaml` document. */
export function validateBindings(doc: unknown): ParseResult<Bindings> {
  const sink = new ErrorSink();
  if (!isRecord(doc)) {
    sink.add(
      "wrong-type",
      "$",
      `bindings must be a mapping from TP ID to binding, got ${describeType(doc)}`,
    );
    return failResult(sink.errors);
  }
  const out: Bindings = {};
  for (const [key, raw] of Object.entries(doc)) {
    if (!TP_ID_RE.test(key)) {
      sink.add(
        "invalid-id",
        key,
        `binding key ${JSON.stringify(key)} must be a TP-<n> ID`,
      );
      continue;
    }
    const binding = parseBinding(sink, key, raw);
    if (binding) out[key] = binding;
  }
  return sink.finish(out);
}

/** Parses the text of a `bindings.yaml`. */
export function parseBindings(text: string): ParseResult<Bindings> {
  const decoded = parseYamlText(text);
  if (!decoded.ok) return decoded;
  return validateBindings(decoded.value);
}
