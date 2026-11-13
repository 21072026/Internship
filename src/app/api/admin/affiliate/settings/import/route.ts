import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { applySettingsImport, previewSettingsImport, readTransferBody, withImportSlot } from '@/lib/affiliateSettingsTransfer';
import { defaultSelection, parseTransferFile, presentSections, resolveSelection } from '@/lib/affiliateSettingsTransferRule';

// POST <the exported JSON file as the body> — imports a programme's settings
// (#3622, docs/affiliate-module.md § Moving the settings). `affiliate.write`,
// MARKETING only; the org comes from the session, never the file.
//
//   ?dryRun=1                         → 200 { sections, preview, defaultSelection }; writes nothing.
//   ?sections=landing,contract[,plan] → applies those sections through their own
//                                       writers, in a fixed order, the plan last.
//   &confirmPlan=1                    → required whenever `plan` is selected.
//
// Refusals: 413 `too_large`; 400 `not_json` | `format` | `version` | `sections` |
// `assets` | `asset_invalid` | `asset_duplicate` (the file), `empty` |
// `unknown_section` | `not_in_file` | `plan_unconfirmed` (the selection), `invalid`
// with the preview (a selected section would not save — nothing was written);
// 409 `conflict` | `asset_refused` with `section` and the sections already applied;
// 409 `busy` while another import of this organisation runs in this process.
export async function POST(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const slot = await withImportSlot(orgId, () => handle(request, orgId, auth.session.user.id));
  return slot.ok ? slot.value : NextResponse.json({ code: 'busy' }, { status: 409 });
}

async function handle(request: Request, orgId: string, actorId: string): Promise<NextResponse> {
  const body = await readTransferBody(request);
  if (!body.ok) return NextResponse.json({ code: body.issue }, { status: body.issue === 'too_large' ? 413 : 400 });
  const parsed = parseTransferFile(body.json);
  if (!parsed.ok) return NextResponse.json({ code: parsed.issue }, { status: 400 });
  const file = parsed.file;
  const present = presentSections(file);
  const url = new URL(request.url);

  if (url.searchParams.get('dryRun') === '1') {
    const preview = await previewSettingsImport(orgId, file);
    return NextResponse.json({ sections: present, preview, defaultSelection: defaultSelection(present), exportedAt: file.exportedAt, appVersion: file.appVersion });
  }

  const selection = resolveSelection(url.searchParams.get('sections'), present, url.searchParams.get('confirmPlan') === '1');
  if (!selection.ok) return NextResponse.json({ code: selection.issue }, { status: 400 });
  const outcome = await applySettingsImport(orgId, file, selection.sections, actorId);
  if (outcome.ok) return NextResponse.json({ ok: true, applied: outcome.applied });
  if (outcome.code === 'invalid') return NextResponse.json({ code: 'invalid', preview: outcome.preview }, { status: 400 });
  return NextResponse.json({ code: outcome.code, section: outcome.section, applied: outcome.applied }, { status: 409 });
}
