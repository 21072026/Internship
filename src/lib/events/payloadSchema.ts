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

import type { ZodTypeAny } from 'zod';
import { EVENT_CATALOG } from './catalog';

export type JsonSchema = { [key: string]: unknown };

// zod v3 keeps its shape on `_def`; the typed surface does not expose it.
type Def = { typeName: string; [key: string]: unknown };
const defOf = (schema: ZodTypeAny): Def => (schema as unknown as { _def: Def })._def;

/** JSON Schema for one zod schema, or a throw naming the construct it cannot describe. */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const def = defOf(schema);
  switch (def.typeName) {
    case 'ZodString': {
      const checks = (def.checks as { kind: string }[] | undefined) ?? [];
      const out: JsonSchema = { type: 'string' };
      if (checks.some((c) => c.kind === 'datetime')) out.format = 'date-time';
      if (checks.some((c) => c.kind === 'min')) out.minLength = 1;
      return out;
    }
    case 'ZodNumber': {
      const checks = (def.checks as { kind: string; value?: number; inclusive?: boolean }[] | undefined) ?? [];
      const out: JsonSchema = { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
      for (const c of checks) {
        if (c.kind === 'min') out[c.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = c.value;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodLiteral':
      return { const: def.value };
    case 'ZodEnum':
      return { type: 'string', enum: [...(def.values as string[])] };
    case 'ZodNullable': {
      const inner = zodToJsonSchema(def.innerType as ZodTypeAny);
      return typeof inner.type === 'string' ? { ...inner, type: [inner.type, 'null'] } : { anyOf: [inner, { type: 'null' }] };
    }
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        if (defOf(value).typeName === 'ZodOptional') {
          properties[key] = zodToJsonSchema(defOf(value).innerType as ZodTypeAny);
        } else {
          properties[key] = zodToJsonSchema(value);
          required.push(key);
        }
      }
      const out: JsonSchema = { type: 'object', properties, required };
      if (def.unknownKeys === 'strict') out.additionalProperties = false;
      return out;
    }
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type as ZodTypeAny) };
    case 'ZodUnion':
      return { anyOf: (def.options as ZodTypeAny[]).map(zodToJsonSchema) };
    default:
      throw new Error(`payloadSchema: cannot describe zod ${def.typeName} — extend zodToJsonSchema before publishing it`);
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
