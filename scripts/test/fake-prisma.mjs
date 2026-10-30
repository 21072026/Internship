// An in-memory stand-in for the Prisma client, for node-runner unit tests of
// modules that import src/lib/prisma.ts (#1598).
//
// `src/lib/prisma.ts` reuses `globalThis.prisma` when one is already there (its
// dev hot-reload guard), so a test that seats this fake BEFORE its first
// dynamic import gets every `prisma.<model>.<op>()` in the module graph routed
// here — no database, no generated-client engine, nothing to mock per module.
//
// Each call is recorded in `calls` and answered by `handlers['model.op']` when a
// test set one, otherwise by a neutral default (an empty list, null, zero, a
// `{ count: 0 }`). Handlers are read at call time, so a test reassigns them
// between cases; `reset()` clears both.
//
//   const db = installFakePrisma();
//   const { foo } = await import('../../src/lib/foo.ts');
//   db.handlers['message.findMany'] = () => [ … ];
const DEFAULTS = {
  findMany: () => [],
  groupBy: () => [],
  findFirst: () => null,
  findUnique: () => null,
  findFirstOrThrow: () => {
    throw new Error('fake prisma: no row');
  },
  findUniqueOrThrow: () => {
    throw new Error('fake prisma: no row');
  },
  count: () => 0,
  aggregate: () => ({ _count: { _all: 0 }, _sum: {}, _max: {}, _min: {} }),
  updateMany: () => ({ count: 0 }),
  deleteMany: () => ({ count: 0 }),
  createMany: () => ({ count: 0 }),
  create: (args) => ({ ...(args?.data ?? {}) }),
  update: (args) => ({ ...(args?.data ?? {}) }),
  upsert: (args) => ({ ...(args?.create ?? {}) }),
  delete: () => ({}),
};

export function installFakePrisma() {
  const handlers = {};
  const calls = [];
  const middlewares = [];
  const delegate = (model) =>
    new Proxy(
      {},
      {
        get: (_, op) =>
          typeof op === 'symbol'
            ? undefined
            : async (args) => {
                calls.push({ model, op, args });
                const handler = handlers[`${model}.${op}`] ?? DEFAULTS[op];
                if (!handler) throw new Error(`fake prisma: no default for ${model}.${op}`);
                return handler(args);
              },
      }
    );
  const base = {
    $use: (fn) => middlewares.push(fn),
    $transaction: async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(client)),
    $extends: () => client,
    $connect: async () => {},
    $disconnect: async () => {},
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
  };
  const models = new Map();
  const client = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      if (!models.has(prop)) models.set(prop, delegate(prop));
      return models.get(prop);
    },
  });
  globalThis.prisma = client;
  return {
    client,
    handlers,
    calls,
    middlewares,
    reset() {
      for (const k of Object.keys(handlers)) delete handlers[k];
      calls.length = 0;
    },
  };
}
