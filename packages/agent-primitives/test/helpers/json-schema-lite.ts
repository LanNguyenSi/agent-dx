/**
 * A minimal JSON Schema checker for the evidence envelope schema: just the
 * keywords that schema uses, so the tests need no validator dependency. A
 * keyword it does not implement THROWS instead of being ignored, so a
 * schema edit that starts relying on one cannot pass silently here.
 */

type Json = unknown;
type Schema = boolean | { [key: string]: Json };

/** Keywords that carry no constraint. */
const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
]);

const IMPLEMENTED = new Set([
  ...ANNOTATIONS,
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "minItems",
  "items",
  "required",
  "properties",
  "additionalProperties",
  "allOf",
  "if",
  "then",
  "else",
  "not",
]);

function typeOf(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: Json, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

function deepEqual(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The violations of `value` against `schema`, as `path: message` strings;
 * empty when it is valid. */
export function validate(schema: Schema, value: Json, at = "$"): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${at}: no value is allowed here`];
  const errors: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!IMPLEMENTED.has(key)) {
      throw new Error(
        `json-schema-lite does not implement the keyword "${key}"`,
      );
    }
  }

  if ("type" in schema) {
    const types = (
      Array.isArray(schema.type) ? schema.type : [schema.type]
    ) as string[];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(
        `${at}: expected ${types.join(" or ")}, got ${typeOf(value)}`,
      );
    }
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (
    "enum" in schema &&
    !(schema.enum as Json[]).some((e) => deepEqual(e, value))
  ) {
    errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string") {
    if (
      "pattern" in schema &&
      !new RegExp(schema.pattern as string).test(value)
    ) {
      errors.push(`${at}: does not match ${String(schema.pattern)}`);
    }
    if (
      "minLength" in schema &&
      [...value].length < (schema.minLength as number)
    ) {
      errors.push(`${at}: shorter than ${String(schema.minLength)}`);
    }
    if (
      "maxLength" in schema &&
      [...value].length > (schema.maxLength as number)
    ) {
      errors.push(`${at}: longer than ${String(schema.maxLength)}`);
    }
  }
  if (Array.isArray(value)) {
    if ("minItems" in schema && value.length < (schema.minItems as number)) {
      errors.push(`${at}: fewer than ${String(schema.minItems)} items`);
    }
    if ("items" in schema) {
      value.forEach((item, i) => {
        errors.push(...validate(schema.items as Schema, item, `${at}[${i}]`));
      });
    }
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, Json>;
    for (const name of (schema.required as string[] | undefined) ?? []) {
      if (!Object.prototype.hasOwnProperty.call(obj, name)) {
        errors.push(`${at}: missing required property "${name}"`);
      }
    }
    const properties =
      (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [name, sub] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(obj, name)) {
        errors.push(...validate(sub, obj[name], `${at}.${name}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(obj)) {
        if (!(name in properties))
          errors.push(`${at}: unexpected property "${name}"`);
      }
    } else if ("additionalProperties" in schema) {
      throw new Error(
        "json-schema-lite only implements additionalProperties: false",
      );
    }
  }
  for (const sub of (schema.allOf as Schema[] | undefined) ?? []) {
    errors.push(...validate(sub, value, at));
  }
  if ("if" in schema) {
    const branch =
      validate(schema.if as Schema, value, at).length === 0
        ? schema.then
        : schema.else;
    if (branch !== undefined)
      errors.push(...validate(branch as Schema, value, at));
  }
  if (
    "not" in schema &&
    validate(schema.not as Schema, value, at).length === 0
  ) {
    errors.push(`${at}: must not match the "not" schema`);
  }
  return errors;
}
