// zod's default error messages, worded exactly as zod 3 wrote them (#3558).
//
// zod 4 rewrote every default message ("Required" became "Invalid input:
// expected string, received undefined", "Invalid email" became "Invalid email
// address", …). Those defaults reach people: a form field without its own
// message shows one under the input, and many routes answer with
// `issues[].message`. The upgrade must not change what anyone reads, so this map
// reproduces the zod 3 wording for every issue a schema does not word itself.
//
// A message written on the schema (`.min(1, 'Name is required')`,
// `{ error: 'invalid_type' }`) always wins: zod consults this map only after
// the schema's own. Returning `undefined` falls through to zod's own default.
//
// Installed with `installZodV3Messages()` once per process: on the server from
// src/instrumentation.ts, in the browser from src/app/providers.tsx. zod keeps
// that configuration on `globalThis`, so every bundled copy of zod in the
// process reads the same map. Dependency-free apart from zod: edge-safe.
import { z } from 'zod';

/** zod 3's name for the type of a value (its `getParsedType`). */
export function v3ParsedType(value: unknown): string {
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return 'string';
    case 'number':
      return Number.isNaN(value) ? 'nan' : 'number';
    case 'boolean':
      return 'boolean';
    case 'function':
      return 'function';
    case 'bigint':
      return 'bigint';
    case 'symbol':
      return 'symbol';
    default:
      if (Array.isArray(value)) return 'array';
      if (value === null) return 'null';
      if (value instanceof Promise) return 'promise';
      if (value instanceof Map) return 'map';
      if (value instanceof Set) return 'set';
      if (value instanceof Date) return 'date';
      return 'object';
  }
}

const quote = (v: unknown) => (typeof v === 'string' ? `'${v}'` : String(v));

const FORMAT_MESSAGES: Record<string, string> = {
  email: 'Invalid email',
  url: 'Invalid url',
  uuid: 'Invalid uuid',
  guid: 'Invalid uuid',
  cuid: 'Invalid cuid',
  cuid2: 'Invalid cuid2',
  ulid: 'Invalid ulid',
  regex: 'Invalid',
  datetime: 'Invalid datetime',
  date: 'Invalid date',
  time: 'Invalid time',
  duration: 'Invalid duration',
  ipv4: 'Invalid ip',
  ipv6: 'Invalid ip',
  cidrv4: 'Invalid cidr',
  cidrv6: 'Invalid cidr',
  base64: 'Invalid base64',
  base64url: 'Invalid base64url',
  emoji: 'Invalid emoji',
  nanoid: 'Invalid nanoid',
  jwt: 'Invalid jwt',
};

type Issue = {
  code: string;
  input?: unknown;
  expected?: string;
  values?: unknown[];
  keys?: string[];
  format?: string;
  prefix?: string;
  suffix?: string;
  includes?: string;
  position?: number;
  origin?: string;
  minimum?: number | bigint | Date;
  maximum?: number | bigint | Date;
  inclusive?: boolean;
  exact?: boolean;
  divisor?: number;
};

/** The zod 3 wording for one zod 4 issue, or undefined to keep zod's own. */
export function v3Message(issue: Issue): string | undefined {
  switch (issue.code) {
    case 'invalid_type': {
      const received = v3ParsedType(issue.input);
      if (received === 'undefined') return 'Required';
      if (issue.expected === 'int') return received === 'number' ? 'Expected integer, received float' : `Expected integer, received ${received}`;
      return `Expected ${issue.expected}, received ${received}`;
    }
    case 'invalid_value': {
      const values = issue.values ?? [];
      if (values.length === 1) return `Invalid literal value, expected ${JSON.stringify(values[0])}`;
      return `Invalid enum value. Expected ${values.map(quote).join(' | ')}, received ${quote(issue.input)}`;
    }
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${(issue.keys ?? []).map((k) => `'${k}'`).join(', ')}`;
    case 'invalid_union':
    case 'invalid_key':
    case 'invalid_element':
    case 'custom':
      return 'Invalid input';
    case 'invalid_format': {
      if (issue.format === 'starts_with') return `Invalid input: must start with "${issue.prefix}"`;
      if (issue.format === 'ends_with') return `Invalid input: must end with "${issue.suffix}"`;
      if (issue.format === 'includes') {
        return typeof issue.position === 'number'
          ? `Invalid input: must include "${issue.includes}" at one or more positions greater than or equal to ${issue.position}`
          : `Invalid input: must include "${issue.includes}"`;
      }
      return FORMAT_MESSAGES[issue.format ?? ''] ?? `Invalid ${issue.format ?? 'input'}`;
    }
    case 'too_small': {
      const { origin, minimum, inclusive, exact } = issue;
      if (origin === 'array') return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${minimum} element(s)`;
      if (origin === 'string') return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${minimum} character(s)`;
      if (origin === 'number' || origin === 'bigint') {
        return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${minimum}`;
      }
      if (origin === 'date') {
        return `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(minimum))}`;
      }
      return 'Invalid input';
    }
    case 'too_big': {
      const { origin, maximum, inclusive, exact } = issue;
      if (origin === 'array') return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${maximum} element(s)`;
      if (origin === 'string') return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${maximum} character(s)`;
      if (origin === 'number') return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
      if (origin === 'bigint') return `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
      if (origin === 'date') {
        return `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(maximum))}`;
      }
      return 'Invalid input';
    }
    case 'not_multiple_of':
      return `Number must be a multiple of ${issue.divisor}`;
    default:
      return undefined;
  }
}

/** Make every zod default message in this process read as zod 3 wrote it. */
export function installZodV3Messages(): void {
  z.config({ customError: (issue) => v3Message(issue as unknown as Issue) });
}
