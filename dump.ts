/**
 * Debug dump helper — Aider-compatible variable pretty-printer.
 *
 * Matches Aider's aider/dump.py pattern:
 * ```python
 * def dump(*args, **kwargs):
 *     from aider.dump import dump
 *     dump(foo=foo, bar=bar)
 * ```
 *
 * Usage:
 *   import { dump } from "./dump.js";
 *   dump({ foo, bar });
 *   // → "foo: 42, bar: ['a', 'b']"
 *
 * For verbose-mode debugging, pass a label:
 *   dump({ foo }, "getRankedTags");
 *   // → "[getRankedTags] foo: 42"
 */
import { inspect } from "node:util";

/**
 * Pretty-print an object's key-value pairs for debugging.
 *
 * @param obj - Object with named values to dump
 * @param label - Optional label prefix
 * @param stream - Output stream (default: process.stderr)
 * @param depth - Inspection depth (default: 3)
 */
export function dump(
  obj: Record<string, unknown>,
  label?: string,
  stream: NodeJS.WriteStream = process.stderr,
  depth = 3,
): void {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const inspected = inspect(value, {
      colors: false,
      depth,
      compact: true,
      breakLength: 80,
      maxArrayLength: 20,
      maxStringLength: 200,
    });
    parts.push(`${key}=${inspected}`);
  }

  const prefix = label ? `[${label}] ` : "";
  stream.write(`${prefix}${parts.join(", ")}\n`);
}

/**
 * Conditional dump — only prints if verbose is true.
 */
export function vdump(
  verbose: boolean,
  obj: Record<string, unknown>,
  label?: string,
): void {
  if (verbose) {
    dump(obj, label);
  }
}

/**
 * Dump a single named value.
 * Convenience wrapper when you just want one variable.
 */
export function dump1(
  name: string,
  value: unknown,
  label?: string,
): void {
  dump({ [name]: value }, label);
}
