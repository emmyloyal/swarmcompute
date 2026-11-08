/**
 * Deterministic JSON for signing: object keys sorted by UTF-16 code unit,
 * no whitespace. Rejects values that do not round-trip (undefined, NaN,
 * Infinity, non-integer or unsafe numbers, bigint, functions, symbols).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function serialize(v: unknown, path: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "string":
      return JSON.stringify(v);
    case "number":
      if (!Number.isSafeInteger(v)) {
        throw new TypeError(`${path}: only safe integers are allowed in signed messages (money must be a string)`);
      }
      return String(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x, i) => serialize(x, `${path}[${i}]`)).join(",")}]`;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path}: only plain objects allowed`);
      const entries = Object.keys(v as object)
        .sort()
        .map((k) => {
          const child = (v as Record<string, unknown>)[k];
          if (child === undefined) throw new TypeError(`${path}.${k}: undefined is not allowed`);
          return `${JSON.stringify(k)}:${serialize(child, `${path}.${k}`)}`;
        });
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`${path}: unsupported type ${typeof v}`);
  }
}
