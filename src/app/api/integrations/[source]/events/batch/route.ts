import { NextResponse } from 'next/server';
import { withApiKey } from '@/lib/apiKey';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveIntegrationSource } from '@/lib/integrationSources';
import { guardSourceRequest, parseJsonBody } from '@/lib/integrationSourceGuard';
import { accountEventSchema, type AccountEvent } from '@/lib/accountEventSchema';
import {
  ACCOUNT_EVENT_BATCH_MAX,
  DryRunBusyError,
  ingestAccountEventBatch,
  MissingReplayStagesError,
} from '@/lib/accountEventIngest';

// POST — up to ACCOUNT_EVENT_BATCH_MAX account events of one registered source
// in one request (#2966), the replay path. The public contract is
// docs/integrations/account-events.md § Batch.
//
// THE DOOR IS THE SINGLE ROUTE'S, IN THE SAME ORDER (../route.ts says why the
// order is the security model): the API key with `companies:write` (401/403,
// before the slug is looked at), the source resolved inside the key's org (one
// 404 `unknown_source` for every kind of miss), the key binding (403
// `wrong_source_key`), the source's IP allowlist and request signature (#2978,
// verified on the raw bytes — a dry run is signed like any other request), the
// `companies` capability — and only then the body.
// withApiKey rate-limits and charges the key's quota ONCE for the request,
// however many events it carries.
//
// THE BODY is `{ events: [...], dry_run?: boolean }`. Every event is validated
// before any is handled: one invalid event refuses the whole batch with a 400
// whose issue paths name it (`events.3.external_id`), so a sender never has to
// work out which half of a batch landed. More than ACCOUNT_EVENT_BATCH_MAX
// events is a 400 `too_many_events`.
//
// THE WRITER is ingestAccountEventBatch (src/lib/accountEventIngest.ts): sorted
// by (external_id, occurred_at), one ingestAccountEvent call each, every one in
// historic mode; `dry_run: true` is the same loop rolled back. The answer is
// 200 with one result per event, in the request's order — a
// `no_default_owner` is one of them, not a 409 for the batch. Two refusals
// come before any event is claimed: 409 `missing_stages` (the org's funnel
// lacks a stage a replay writes into) and, for a dry run, 429 `dry_run_busy`
// (another dry run is running in this process).
//
// Listed in scripts/check-api-key-routes.mjs next to the single route.

export async function POST(request: Request, { params }: { params: Promise<{ source: string }> }) {
  return withRequestScope(request, () =>
    withApiKey(request, 'companies:write', async (key) => {
      const source = await resolveIntegrationSource(key.orgId, (await params).source);
      if (!source) {
        return NextResponse.json(
          { code: 'unknown_source', error: 'No integration source with this name is registered for your organization.' },
          { status: 404 },
        );
      }
      if (source.apiKeyId && source.apiKeyId !== key.id) {
        return NextResponse.json(
          { code: 'wrong_source_key', error: 'This integration source accepts events from a different API key.' },
          { status: 403 },
        );
      }

      const guarded = await guardSourceRequest(request, key.orgId, source);
      if (!guarded.ok) return guarded.response;

      const gated = await requireCapability(key.orgId, 'companies');
      if (gated) return gated;

      const body = parseJsonBody(guarded.rawBody) as { events?: unknown; dry_run?: unknown } | null;
      if (!body || typeof body !== 'object' || !Array.isArray(body.events) || body.events.length === 0) {
        return NextResponse.json(
          { error: 'Invalid batch', issues: [{ path: 'events', message: 'events: a non-empty array of account events' }] },
          { status: 400 },
        );
      }
      if (body.events.length > ACCOUNT_EVENT_BATCH_MAX) {
        return NextResponse.json(
          {
            code: 'too_many_events',
            error: `A batch carries at most ${ACCOUNT_EVENT_BATCH_MAX} events; this one has ${body.events.length}.`,
          },
          { status: 400 },
        );
      }
      if (body.dry_run !== undefined && body.dry_run !== null && typeof body.dry_run !== 'boolean') {
        return NextResponse.json(
          { error: 'Invalid batch', issues: [{ path: 'dry_run', message: 'dry_run: a boolean' }] },
          { status: 400 },
        );
      }

      const events: AccountEvent[] = [];
      const issues: { path: string; message: string }[] = [];
      body.events.forEach((raw, index) => {
        const parsed = accountEventSchema.safeParse(raw);
        if (parsed.success) events.push(parsed.data);
        else for (const i of parsed.error.issues) issues.push({ path: ['events', index, ...i.path].join('.'), message: i.message });
      });
      if (issues.length > 0) {
        return NextResponse.json({ error: 'Invalid event', issues: issues.slice(0, 100) }, { status: 400 });
      }

      const dryRun = body.dry_run === true;
      try {
        const results = await ingestAccountEventBatch(key.orgId, source, events, { dryRun });
        return NextResponse.json({ dry_run: dryRun, results });
      } catch (e) {
        if (e instanceof MissingReplayStagesError) {
          return NextResponse.json(
            {
              code: 'missing_stages',
              stages: e.stages,
              error: 'The organization\'s funnel lacks stages a replay writes into. Nothing was handled; resend once they exist.',
            },
            { status: 409 },
          );
        }
        if (e instanceof DryRunBusyError) {
          return NextResponse.json(
            { code: 'dry_run_busy', error: 'Another dry run is running. Nothing was handled; retry shortly.' },
            { status: 429, headers: { 'Retry-After': '30' } },
          );
        }
        throw e;
      }
    }),
  );
}
