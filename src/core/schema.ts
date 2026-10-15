import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";

export type Validation = { ok: true } | { ok: false; errors: string };

const ajv = new Ajv2020({ allErrors: true, strict: true, multipleOfPrecision: 6 });
const compiled = new Map<string, ValidateFunction>();

/** Schemas live in `<package>/schemas`, two levels above both `src/core` and `dist/core`. */
export function schemaUrl(name: string): URL {
  return new URL(`../../schemas/${name}`, import.meta.url);
}

export function validate(name: string, data: unknown): Validation {
  let fn = compiled.get(name);
  if (!fn) {
    fn = ajv.compile(JSON.parse(readFileSync(schemaUrl(name), "utf8")));
    compiled.set(name, fn);
  }
  return fn(data) ? { ok: true } : { ok: false, errors: ajv.errorsText(fn.errors) };
}

/**
 * Validates `data` against one definition inside a schema file, for example `candidate` in
 * `reconcile-output.schema.json` (`#/$defs/candidate`). A file that holds an envelope and the shape of its
 * items needs both checks, and the second one runs once per item so that one bad item does not void the others.
 */
export function validateDef(name: string, def: string, data: unknown): Validation {
  const key = `${name}#/$defs/${def}`;
  let fn = compiled.get(key);
  if (!fn) {
    const schema = JSON.parse(readFileSync(schemaUrl(name), "utf8")) as { $defs?: Record<string, unknown> };
    if (schema.$defs?.[def] === undefined) throw new Error(`${name} has no definition ${def}`);
    fn = ajv.compile({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: schema.$defs,
      $ref: `#/$defs/${def}`,
    });
    compiled.set(key, fn);
  }
  return fn(data) ? { ok: true } : { ok: false, errors: ajv.errorsText(fn.errors) };
}
