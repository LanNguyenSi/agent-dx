/**
 * `.spec-gate/commands.yaml`: the only commands a runner may execute.
 *
 * ```yaml
 * discovery:
 *   argv: ["npx", "vitest", "list"]
 * commands:
 *   unit:
 *     argv: ["npx", "vitest", "run", "-t", "{selector}"]
 *   typecheck:
 *     argv: ["npm", "run", "typecheck"]
 * ```
 *
 * A command is an argv list, never a shell string: a string where an
 * argv list belongs is rejected (`shell-string`). The one placeholder is
 * `{selector}`, valid only as a whole argv element and never as the
 * program (`selector-embedded`, `selector-as-program`). `discovery` is the
 * command whose output lists the valid selectors; it takes no
 * placeholder and is required as soon as one command uses `{selector}`.
 *
 * The file does not stop a person from writing `["sh", "-c", "..."]`. The
 * pull request that adds a command is where that is reviewed.
 */
import type { ParseResult } from "./errors.js";
import { ErrorSink, failResult } from "./errors.js";
import { parseYamlText } from "./input.js";
import type { Rec } from "./validate.js";
import {
  describeType,
  hasOwn,
  isRecord,
  rejectUnknownKeys,
} from "./validate.js";

/** The placeholder a runner replaces by one selector. */
export const SELECTOR_PLACEHOLDER = "{selector}";

export interface CommandEntry {
  name: string;
  argv: string[];
  /** True when an argv element is exactly `{selector}`. */
  usesSelector: boolean;
}

export interface CommandSet {
  discovery?: string[];
  /** In file order. */
  commands: CommandEntry[];
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function parseArgv(
  sink: ErrorSink,
  raw: unknown,
  path: string,
  allowSelector: boolean,
): string[] | undefined {
  if (typeof raw === "string") {
    sink.add(
      "shell-string",
      path,
      `${path} is a string; a command is an argv list such as ["program", "arg"], never a shell string`,
    );
    return undefined;
  }
  if (!Array.isArray(raw)) {
    sink.add(
      "wrong-type",
      path,
      `${path} must be a list of strings, got ${describeType(raw)}`,
    );
    return undefined;
  }
  if (raw.length === 0) {
    sink.add("empty-value", path, `${path} must not be empty`);
    return undefined;
  }
  const out: string[] = [];
  let good = true;
  raw.forEach((element, i) => {
    const p = `${path}[${i}]`;
    if (typeof element !== "string") {
      sink.add(
        "wrong-type",
        p,
        `argv element must be a string, got ${describeType(element)}`,
      );
      good = false;
      return;
    }
    if (element.includes("\u0000")) {
      sink.add("invalid-value", p, "argv element must not contain NUL");
      good = false;
      return;
    }
    if (i === 0 && element.trim() === "") {
      sink.add(
        "empty-value",
        p,
        "the program (first element) must not be empty",
      );
      good = false;
      return;
    }
    if (element.includes(SELECTOR_PLACEHOLDER)) {
      if (!allowSelector) {
        sink.add(
          "selector-in-discovery",
          p,
          `the discovery command takes no ${SELECTOR_PLACEHOLDER} placeholder`,
        );
        good = false;
      } else if (element !== SELECTOR_PLACEHOLDER) {
        sink.add(
          "selector-embedded",
          p,
          `${SELECTOR_PLACEHOLDER} must be a whole argv element, got ${JSON.stringify(element)}`,
        );
        good = false;
      } else if (i === 0) {
        sink.add(
          "selector-as-program",
          p,
          `${SELECTOR_PLACEHOLDER} must not be the program`,
        );
        good = false;
      }
    }
    out.push(element);
  });
  return good ? out : undefined;
}

/** Validates an already decoded `commands.yaml` document. */
export function validateCommandSet(doc: unknown): ParseResult<CommandSet> {
  const sink = new ErrorSink();
  if (!isRecord(doc)) {
    sink.add(
      "wrong-type",
      "$",
      `commands file must be a mapping, got ${describeType(doc)}`,
    );
    return failResult(sink.errors);
  }
  const rec: Rec = doc;
  rejectUnknownKeys(sink, rec, ["discovery", "commands"], "", "commands file");

  let discovery: string[] | undefined;
  if (hasOwn(rec, "discovery")) {
    const d = rec["discovery"];
    if (typeof d === "string") {
      sink.add(
        "shell-string",
        "discovery",
        "discovery is a string; give a mapping with an argv list",
      );
    } else if (!isRecord(d)) {
      sink.add(
        "wrong-type",
        "discovery",
        `discovery must be a mapping, got ${describeType(d)}`,
      );
    } else {
      rejectUnknownKeys(sink, d, ["argv"], "discovery", "discovery");
      if (!hasOwn(d, "argv")) {
        sink.add(
          "missing-field",
          "discovery.argv",
          "discovery is missing argv",
        );
      } else {
        discovery = parseArgv(sink, d["argv"], "discovery.argv", false);
      }
    }
  }

  const commands: CommandEntry[] = [];
  if (!hasOwn(rec, "commands")) {
    sink.add("missing-field", "commands", "file is missing field commands");
  } else if (!isRecord(rec["commands"])) {
    sink.add(
      "wrong-type",
      "commands",
      `commands must be a mapping, got ${describeType(rec["commands"])}`,
    );
  } else if (Object.keys(rec["commands"]).length === 0) {
    sink.add(
      "empty-value",
      "commands",
      "commands must name at least one command",
    );
  } else {
    for (const [name, entry] of Object.entries(rec["commands"])) {
      const path = `commands.${name}`;
      if (!NAME_RE.test(name)) {
        sink.add(
          "invalid-value",
          path,
          `command name ${JSON.stringify(name)} must be lower-case letters, digits, '.', '_' or '-'`,
        );
        continue;
      }
      if (typeof entry === "string") {
        sink.add(
          "shell-string",
          path,
          `${path} is a string; give a mapping with an argv list`,
        );
        continue;
      }
      if (!isRecord(entry)) {
        sink.add(
          "wrong-type",
          path,
          `${path} must be a mapping, got ${describeType(entry)}`,
        );
        continue;
      }
      rejectUnknownKeys(sink, entry, ["argv"], path, path);
      if (!hasOwn(entry, "argv")) {
        sink.add("missing-field", `${path}.argv`, `${path} is missing argv`);
        continue;
      }
      const argv = parseArgv(sink, entry["argv"], `${path}.argv`, true);
      if (argv) {
        commands.push({
          name,
          argv,
          usesSelector: argv.includes(SELECTOR_PLACEHOLDER),
        });
      }
    }
  }
  if (
    sink.empty &&
    discovery === undefined &&
    commands.some((c) => c.usesSelector)
  ) {
    sink.add(
      "discovery-required",
      "discovery",
      `a command uses ${SELECTOR_PLACEHOLDER}, so the file needs a discovery command that lists the valid selectors`,
    );
  }
  if (!sink.empty) return failResult(sink.errors);
  const out: CommandSet = { commands };
  if (discovery) out.discovery = discovery;
  return sink.finish(out);
}

/** Parses the text of a `.spec-gate/commands.yaml`. */
export function parseCommandSet(text: string): ParseResult<CommandSet> {
  const decoded = parseYamlText(text);
  if (!decoded.ok) return decoded;
  return validateCommandSet(decoded.value);
}
