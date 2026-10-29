// A small, STRICT validator for the JSON Schema subset /api/v1/openapi.json
// uses (#1611). Two directions on purpose:
//
//   • every documented `required` key must be there, with the documented type,
//     enum, const or date-time format;
//   • every key a response carries must be documented — an object schema that
//     lists `properties` is closed unless it says `additionalProperties`
//     itself. A field that ships without a line in the spec is an undocumented
//     promise an integrator will start to rely on.
//
// No dependency: the subset is small (type incl. arrays of types, required,
// properties, additionalProperties, items, enum, const, format: date-time,
// anyOf, $ref into the same document) and anything else is reported rather
// than silently accepted.

type Schema = { [key: string]: unknown };

const KNOWN = new Set([
  'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'format', 'anyOf', '$ref',
  'description', 'deprecated', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'minProperties',
  'nullable', 'example', 'title', 'default',
]);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

/** Every problem with `value` against `schema`, as `path: message` lines; empty when it conforms. */
export function strictValidate(value: unknown, schema: Schema, root: Schema, path = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    const target = (schema.$ref as string)
      .replace(/^#\//, '')
      .split('/')
      .reduce<unknown>((node, key) => (node as Schema | undefined)?.[key], root) as Schema | undefined;
    if (!target) return [`${path}: unresolvable $ref ${schema.$ref}`];
    return strictValidate(value, target, root, path);
  }
  const unknownKeywords = Object.keys(schema).filter((k) => !KNOWN.has(k));
  if (unknownKeywords.length) return [`${path}: schema keyword(s) this validator does not understand: ${unknownKeywords.join(', ')}`];

  if (Array.isArray(schema.anyOf)) {
    const branches = (schema.anyOf as Schema[]).map((s) => strictValidate(value, s, root, path));
    return branches.some((b) => b.length === 0) ? [] : [`${path}: matches none of anyOf (${branches.map((b) => b[0]).join(' | ')})`];
  }

  const problems: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => matchesType(value, t))) return [`${path}: expected ${types.join('|')}, got ${typeOf(value)}`];
  }
  if ('const' in schema && value !== schema.const) problems.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.format === 'date-time' && typeof value === 'string' && Number.isNaN(Date.parse(value))) {
    problems.push(`${path}: "${value}" is not a date-time`);
  }
  if (typeOf(value) === 'array' && schema.items) {
    (value as unknown[]).forEach((item, i) => problems.push(...strictValidate(item, schema.items as Schema, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties as Record<string, Schema> | undefined) ?? undefined;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in obj)) problems.push(`${path}.${key}: documented as required, missing from the response`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (props && key in props) {
        problems.push(...strictValidate(v, props[key], root, `${path}.${key}`));
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        problems.push(...strictValidate(v, schema.additionalProperties as Schema, root, `${path}.${key}`));
      } else if (props && schema.additionalProperties !== true) {
        problems.push(`${path}.${key}: in the response but not in the published schema`);
      }
    }
  }
  return problems;
}
