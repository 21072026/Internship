# 2026-10-30 — cross-replica realtime bus over Redis pub/sub (#1698)

- **Reuse the rate-limit store's RESP** (`encodeCommand`/`parseReply`, now exported from
  `src/lib/rateLimitRedis.ts`) instead of adding a Redis client: pub/sub is two sockets,
  PUBLISH on one and SUBSCRIBE on the other; a subscribed socket receives
  `['message', channel, payload]` arrays.
- **Test pub/sub with a 40-line RESP server on 127.0.0.1** (see
  `scripts/test/realtime-broker.test.mjs`): real framing, AUTH/SELECT/SUBSCRIBE/PUBLISH,
  and `dropAll()` to prove the redial. node:test runs each file in its own process, so a
  test may set `process.env.REALTIME_REDIS_URL` and import the globalThis-singleton bus.
- Two sockets fail independently: bump a generation counter when tearing down, so the
  second socket's `close` does not schedule a second redial.
