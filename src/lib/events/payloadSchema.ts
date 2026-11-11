// The published shape of every public event's payload (#1611).
//
// The catalogue (./catalog.ts) holds each payload as a strict zod schema; a
// webhook receiver cannot read zod. This turns those schemas into JSON Schema
// for the `x-webhooks` block of /api/v1/openapi.json, and the committed
// snapshot in scripts/test/fixtures/webhook-payloads.json pins the result: a
// renamed, removed or added key in a public payload fails
// scripts/test/webhook-contract.test.mjs, which is the point. A payload change
// that would break a receiver is a NEW catalogue entry with `version: 2`, not
// an edit of version 1.
//
// Only the zod constructs the catalogue uses are understood, and anything else
// THROWS rather than being published as "anything goes" — a schema this file
// cannot describe faithfully must not reach a receiver as a promise.
//
// Dependency-free apart from zod, like the catalogue: safe for the route, a
// unit test or a script.

import type { ZodType } from 'zod';
import { EVENT_CATALOG } from './catalog';

export type JsonSchema = { [key: string]: unknown };

// zod keeps a schema's shape on `_zod.def` (v4); the typed surface does not
// expose the fields this walker reads, so they are read through a loose view.
type Check = { check: string; format?: string; value?: number; inclusive?: boolean };
type Def = { type: string; checks?: { _zod: { def: Check } }[]; [key: string]: unknown };
const defOf = (schema: ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;
const checksOf = (def: Def): Check[] => (def.checks ?? []).map((c) => c._zod.def);
/** The v3-style construct name (`any` → `ZodAny`) the refusal message has always used. */
const zodName = (type: string) => `Zod${type.charAt(0).toUpperCase()}${type.slice(1)}`;

/** JSON Schema for one zod schema, or a throw naming the construct it cannot describe. */
export function zodToJsonSchema(schema: ZodType): JsonSchema {
  const def = defOf(schema);
  switch (def.type) {
    case 'string': {
      const checks = checksOf(def);
      const out: JsonSchema = { type: 'string' };
      if (checks.some((c) => c.check === 'string_format' && c.format === 'datetime')) out.format = 'date-time';
      if (checks.some((c) => c.check === 'min_length')) out.minLength = 1;
      return out;
    }
    case 'number': {
      const checks = checksOf(def);
      const isInt = checks.some((c) => c.check === 'number_format' && (c.format === 'safeint' || c.format === 'int32'));
      const out: JsonSchema = { type: isInt ? 'integer' : 'number' };
      for (const c of checks) {
        if (c.check === 'greater_than') out[c.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = c.value;
      }
      return out;
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'literal': {
      const values = def.values as unknown[];
      if (values.length !== 1) throw new Error('payloadSchema: cannot describe a zod literal with several values');
      return { const: values[0] };
    }
    case 'enum':
      return { type: 'string', enum: Object.values(def.entries as Record<string, string>) };
    case 'nullable': {
      const inner = zodToJsonSchema(def.innerType as ZodType);
      return typeof inner.type === 'string' ? { ...inner, type: [inner.type, 'null'] } : { anyOf: [inner, { type: 'null' }] };
    }
    case 'object': {
      const shape = def.shape as Record<string, ZodType>;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        if (defOf(value).type === 'optional') {
          properties[key] = zodToJsonSchema(defOf(value).innerType as ZodType);
        } else {
          properties[key] = zodToJsonSchema(value);
          required.push(key);
        }
      }
      const out: JsonSchema = { type: 'object', properties, required };
      const catchall = def.catchall as ZodType | undefined;
      if (catchall && defOf(catchall).type === 'never') out.additionalProperties = false;
      return out;
    }
    case 'array':
      return { type: 'array', items: zodToJsonSchema(def.element as ZodType) };
    case 'union':
      return { anyOf: (def.options as ZodType[]).map(zodToJsonSchema) };
    default:
      throw new Error(`payloadSchema: cannot describe zod ${zodName(def.type)} — extend zodToJsonSchema before publishing it`);
  }
}

export interface PublishedEventPayload {
  version: number;
  description: string;
  schema: JsonSchema;
}

/**
 * Every public event's payload, keyed `name@version`, in catalogue order — the
 * `data` of a webhook delivery `{ event, data, sentAt }` for that event.
 */
export function publicEventPayloads(): Record<string, PublishedEventPayload> {
  const out: Record<string, PublishedEventPayload> = {};
  for (const entry of EVENT_CATALOG) {
    if (entry.visibility !== 'public') continue;
    out[`${entry.name}@${entry.version}`] = {
      version: entry.version,
      description: entry.description,
      schema: zodToJsonSchema(entry.payload),
    };
  }
  return out;
}
