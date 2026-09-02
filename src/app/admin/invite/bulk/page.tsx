'use client';

// Bulk invitations (#2070) — paste, preview, send.
//
// The send button stays disabled until a dry run has been shown for exactly
// the text currently in the box: editing the paste or the default role throws
// the preview away, because a preview of something else is worse than none.
import { useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Badge } from '@/components/ui/Badge';
import { Users, ArrowLeft, Copy, Check } from 'lucide-react';
import { useT } from '@/i18n/client';
import { copyToClipboard } from '@/lib/clipboard';
import { BULK_INVITE_MAX_CHARS, type BulkInviteReason, type BulkInviteRole } from '@/lib/bulkInvite';

interface ReportRow {
  row: number;
  email: string;
  role: BulkInviteRole;
  status: 'invite' | 'skip' | 'error';
  reason?: BulkInviteReason;
  possibleDuplicates?: { id: string; fullName: string; matchedOn: string[] }[];
  /** Real run only: whether a mail actually left the app for this row. */
  emailSent?: boolean;
  /** Real run only, unmailed rows only: the link the admin must now share. */
  registerUrl?: string;
}

interface Report {
  dryRun: boolean;
  truncated: boolean;
  total: number;
  invitable: number;
  skipped: number;
  errors: number;
  created: number;
  emailed: number;
  unsent: number;
  rows: ReportRow[];
}

export default function BulkInvitePage() {
  const t = useT();
  const [rows, setRows] = useState('');
  const [defaultRole, setDefaultRole] = useState<BulkInviteRole>('MENTEE');
  const [preview, setPreview] = useState<Report | null>(null);
  const [result, setResult] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const copyLink = async (link: string) => {
    if (await copyToClipboard(link)) {
      setCopied(link);
      setTimeout(() => setCopied((c) => (c === link ? null : c)), 2000);
    }
  };

  const reasonLabel = (reason?: BulkInviteReason) =>
    reason ? (t.bulkInvite.reasons as Record<string, string>)[reason] ?? reason : '';

  // Any edit invalidates the shown verdict — the send button goes back to
  // disabled rather than sending against a stale preview.
  const invalidate = () => {
    setPreview(null);
    setResult(null);
    setError('');
  };

  const post = async (dryRun: boolean): Promise<Report | null> => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/invite/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, defaultRole, ...(dryRun ? { dryRun: true } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t.bulkInvite.failed);
      return body as Report;
    } catch (err) {
      setError(err instanceof Error ? err.message : t.bulkInvite.failed);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const onPreview = async () => {
    setResult(null);
    const report = await post(true);
    if (report) setPreview(report);
  };

  const onSend = async () => {
    const report = await post(false);
    if (report) {
      setResult(report);
      setPreview(report);
    }
  };

  const shown = result ?? preview;
  const statusTone: Record<ReportRow['status'], 'success' | 'warning' | 'danger'> = {
    invite: 'success',
    skip: 'warning',
    error: 'danger',
  };

  // A created invitation whose mail never left the app is NOT a sent one: demo
  // mode and an env without SMTP both report the transport as skipped without
  // throwing. It gets its own badge (and its link below) so the admin can see
  // the difference at a glance.
  const rowTone = (r: ReportRow) =>
    r.status === 'invite' && r.emailSent === false ? 'warning' : statusTone[r.status];
  const rowLabel = (r: ReportRow) => {
    if (r.status !== 'invite' || r.emailSent === undefined) return t.bulkInvite.status[r.status];
    return r.emailSent ? t.bulkInvite.status.emailed : t.bulkInvite.status.notEmailed;
  };

  return (
    <div>
      <div className="mb-8">
        <Link
          href="/admin/invite"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
        >
          <ArrowLeft className="h-4 w-4" />
          {t.bulkInvite.backToSingle}
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">{t.bulkInvite.title}</h1>
        <p className="text-gray-500 mt-1">{t.bulkInvite.subtitle}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-blue-600" />
              <CardTitle>{t.bulkInvite.inputLabel}</CardTitle>
            </div>
          </CardHeader>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
          )}

          <div className="space-y-4">
            <div>
              <Textarea
                data-testid="bulk-invite-input"
                rows={12}
                maxLength={BULK_INVITE_MAX_CHARS}
                className="font-mono text-xs"
                placeholder={t.bulkInvite.inputPlaceholder}
                value={rows}
                onChange={(e) => {
                  setRows(e.target.value);
                  invalidate();
                }}
              />
              <p className="text-xs text-gray-500 mt-1">{t.bulkInvite.inputHint}</p>
              <p className="text-xs text-gray-500">{t.bulkInvite.formatHint}</p>
            </div>

            <Select
              label={t.bulkInvite.defaultRole}
              hint={t.bulkInvite.defaultRoleHint}
              options={[
                { value: 'MENTEE', label: t.bulkInvite.roleMentee },
                { value: 'MENTOR', label: t.bulkInvite.roleMentor },
              ]}
              value={defaultRole}
              onChange={(e) => {
                setDefaultRole(e.target.value as BulkInviteRole);
                invalidate();
              }}
            />

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                data-testid="bulk-invite-preview-button"
                onClick={onPreview}
                loading={busy && !preview}
                disabled={busy || rows.trim().length === 0}
              >
                {t.bulkInvite.preview}
              </Button>
              <Button
                type="button"
                data-testid="bulk-invite-send"
                onClick={onSend}
                loading={busy && !!preview}
                // The gate the whole screen exists for: nothing is sent before
                // the admin has seen what would be sent.
                disabled={busy || !preview || result !== null || preview.invitable === 0}
              >
                {t.bulkInvite.send}
              </Button>
            </div>
            {!preview && <p className="text-xs text-gray-500">{t.bulkInvite.previewFirst}</p>}
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.bulkInvite.previewTitle}</CardTitle>
          </CardHeader>

          {!shown && <p className="text-sm text-gray-500">{t.bulkInvite.noPreview}</p>}

          {shown && (
            <div data-testid="bulk-invite-preview">
              <div className="flex flex-wrap gap-3 text-sm mb-3">
                <span data-testid="bulk-invite-count-total">
                  {t.bulkInvite.countTotal}: <strong>{shown.total}</strong>
                </span>
                <span className="text-green-700" data-testid="bulk-invite-count-invitable">
                  {t.bulkInvite.countInvitable}: <strong>{shown.invitable}</strong>
                </span>
                <span className="text-amber-700" data-testid="bulk-invite-count-skipped">
                  {t.bulkInvite.countSkipped}: <strong>{shown.skipped}</strong>
                </span>
                <span className="text-red-700" data-testid="bulk-invite-count-errors">
                  {t.bulkInvite.countErrors}: <strong>{shown.errors}</strong>
                </span>
                {result && (
                  <span className="text-amber-700" data-testid="bulk-invite-count-unsent">
                    {t.bulkInvite.countUnsent}: <strong>{result.unsent}</strong>
                  </span>
                )}
              </div>

              {shown.truncated && (
                <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
                  {t.bulkInvite.truncated}
                </div>
              )}

              {result &&
                (result.unsent > 0 ? (
                  // Never "{n} invitations sent." when nothing was mailed (#1431):
                  // the invitations exist, but the admin has to deliver them.
                  <div
                    className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm"
                    data-testid="bulk-invite-result"
                  >
                    {t.bulkInvite.sentPartial
                      .replace('{created}', String(result.created))
                      .replace('{n}', String(result.emailed))
                      .replace('{unsent}', String(result.unsent))}
                  </div>
                ) : (
                  <div
                    className="mb-3 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm"
                    data-testid="bulk-invite-result"
                  >
                    {t.bulkInvite.sent.replace('{n}', String(result.emailed))}
                  </div>
                ))}

              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500">
                      <th className="py-1 pr-3">#</th>
                      <th className="py-1 pr-3">{t.bulkInvite.colEmail}</th>
                      <th className="py-1 pr-3">{t.bulkInvite.colRole}</th>
                      <th className="py-1 pr-3">{t.bulkInvite.colStatus}</th>
                      <th className="py-1">{t.bulkInvite.colReason}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.rows.map((r) => (
                      <tr
                        key={r.row}
                        data-testid={`bulk-invite-row-${r.row}`}
                        data-status={r.status}
                        data-email-sent={r.emailSent === undefined ? undefined : String(r.emailSent)}
                        className="border-t border-gray-100 dark:border-gray-700"
                      >
                        <td className="py-1 pr-3 text-gray-400">{r.row}</td>
                        <td className="py-1 pr-3 font-mono text-xs break-all">{r.email || '—'}</td>
                        <td className="py-1 pr-3">{r.role}</td>
                        <td className="py-1 pr-3">
                          <Badge variant={rowTone(r)}>{rowLabel(r)}</Badge>
                        </td>
                        <td className="py-1 text-gray-600 dark:text-gray-300">
                          {reasonLabel(r.reason)}
                          {r.possibleDuplicates && r.possibleDuplicates.length > 0 && (
                            <span className="block text-xs text-amber-700">
                              {t.bulkInvite.possibleDuplicate.replace(
                                '{names}',
                                r.possibleDuplicates.map((d) => d.fullName).join(', '),
                              )}
                            </span>
                          )}
                          {r.registerUrl && (
                            <span className="mt-1 flex items-center gap-2">
                              <input
                                readOnly
                                value={r.registerUrl}
                                data-testid={`bulk-invite-link-${r.row}`}
                                className="flex-1 min-w-0 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1 text-gray-600"
                              />
                              <button
                                type="button"
                                onClick={() => copyLink(r.registerUrl!)}
                                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 flex-shrink-0"
                              >
                                {copied === r.registerUrl ? (
                                  <>
                                    <Check className="h-3.5 w-3.5" /> {t.invite.copied}
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3.5 w-3.5" /> {t.invite.copy}
                                  </>
                                )}
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
