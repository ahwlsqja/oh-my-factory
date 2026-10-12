import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";

export type Validation = { ok: true } | { ok: false; errors: string };

const ajv = new Ajv2020({ allErrors: true, strict: true });
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
