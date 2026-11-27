'use client';

import { useCallback, useEffect, useState } from 'react';
import { UserRoundPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { useToast } from '@/components/ui/Toast';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { followUpNoteMissing, type HandoffAction } from '@/lib/leadHandoffRule';
import { FollowUpFields, localDayFromToday } from '@/components/FollowUpFields';
import { FollowUpImagePicker, useFollowUpImageDrafts } from '@/components/FollowUpImages';

// The rep strip above the sales and admin boards and its dialog: drop a lead
// card on a colleague (or use the card's "Hand over" button — the single-pointer
// alternative to dragging, WCAG 2.5.7), pick what they should do, done. The
// write is POST /api/sales/leads/[id]/handoff (src/lib/leadHandoff.ts).
//
// The strip renders nothing outside MARKETING: GET /api/sales/team answers 403
// there, and an empty team is no strip.

export interface TeamMember {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  self: boolean;
  /** Load line (#3875): their open records, and overdue follow-ups when the viewer may see them (else null). */
  open?: number;
  overdue?: number | null;
  /** Open follow-ups by channel (#3905), under the same rule as `overdue` (else null). */
  followUps?: { call: number; email: number; other: number } | null;
}

interface Pending {
  relationId: string;
  leadName: string;
  recipientId: string | null;
}

/** GET /api/sales/leads/[id]/handoff (#3873): who has it now, and its follow-up. */
interface Current {
  ownerId: string;
  ownerName: string;
  nextActionAt: string | null;
  nextActionNote: string | null;
  nextActionTime?: string | null;
}

/** Plain-text slots: the title and the toast are strings, not elements. */
function fill(template: string, slots: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => slots[key] ?? whole);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/**
 * Everything the board needs: the strip, the dialog and an opener for the
 * per-card button. `includeSelf` is the admin board's choice (an admin may take
 * a record onto their own book); a rep's own board leaves them out, since their
 * own leads are already theirs.
 */
export function useLeadHandoff(opts: {
  includeSelf: boolean;
  nameOf: (relationId: string) => string | undefined;
  onHandedOff: () => void;
  /**
   * A name on the strip also filters the board to that person (#3906): given
   * only where the viewer may see the team's records (the board's own rule), so
   * nobody is offered a filter the board would refuse. Absent, names are plain.
   */
  select?: { selected: readonly string[]; onToggle: (memberId: string) => void };
}) {
  const { includeSelf, nameOf, onHandedOff, select } = opts;
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/sales/team')
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d) => alive && setMembers(((d.members ?? []) as TeamMember[]).filter((m) => includeSelf || !m.self)))
      .catch(() => alive && setMembers([]));
    return () => {
      alive = false;
    };
  }, [includeSelf]);

  const open = useCallback(
    (relationId: string, recipientId: string | null) => {
      setPending({ relationId, leadName: nameOf(relationId) ?? '', recipientId });
    },
    [nameOf],
  );

  const enabled = members.length > 0;
  return {
    enabled,
    openFor: (relationId: string) => open(relationId, null),
    strip: enabled ? <LeadHandoffStrip members={members} select={select} onDrop={(memberId, relationId) => open(relationId, memberId)} /> : null,
    dialog: (
      <LeadHandoffDialog
        pending={pending}
        members={members}
        onClose={() => setPending(null)}
        onDone={() => {
          setPending(null);
          onHandedOff();
        }}
      />
    ),
  };
}

function LeadHandoffStrip({
  members,
  onDrop,
  select,
}: {
  members: TeamMember[];
  onDrop: (memberId: string, relationId: string) => void;
  select?: { selected: readonly string[]; onToggle: (memberId: string) => void };
}) {
  const t = useT();
  const h = t.leadHandoff;
  const [over, setOver] = useState<string | null>(null);
  return (
    <section
      aria-label={h.stripLabel}
      data-testid="lead-handoff-strip"
      className="mb-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3"
    >
      <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">
        {h.stripLabel} · <span className="font-normal">{select ? h.stripHintFilter : h.stripHint}</span>
      </p>
      <ul className="flex gap-2 overflow-x-auto pb-1">
        {members.map((m) => (
          <li
            key={m.id}
            data-testid={`handoff-target-${m.id}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(m.id);
            }}
            onDragLeave={() => setOver((prev) => (prev === m.id ? null : prev))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData('relationId');
              if (id) onDrop(m.id, id);
            }}
            className={`flex shrink-0 items-center gap-2 rounded-full border px-2 py-1 pr-3 text-sm transition ${
              over === m.id
                ? 'border-blue-400 bg-blue-50 text-blue-700 ring-2 ring-blue-200'
                : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200'
            }`}
          >
            {m.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={m.avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
            ) : (
              <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-green-100 text-xs font-semibold text-green-700">
                {initials(m.fullName)}
              </span>
            )}
            <span className="flex flex-col leading-tight">
              {select ? (
                // The drop target stays the whole chip; the name is the filter (#3906).
                <button
                  type="button"
                  aria-pressed={select.selected.includes(m.id)}
                  title={h.filterBy.replace('{name}', m.fullName)}
                  onClick={() => select.onToggle(m.id)}
                  data-testid={`handoff-target-filter-${m.id}`}
                  className={`whitespace-nowrap rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                    select.selected.includes(m.id) ? 'font-semibold text-blue-700 dark:text-blue-300' : ''
                  }`}
                >
                  {m.fullName}
                  {m.self && <span className="ml-1 text-xs text-gray-400">({h.you})</span>}
                </button>
              ) : (
                <span className="whitespace-nowrap">
                  {m.fullName}
                  {m.self && <span className="ml-1 text-xs text-gray-400">({h.you})</span>}
                </span>
              )}
              {typeof m.open === 'number' && (
                // Short on purpose (#3976): the open count, and the overdue count
                // only when there is one; the whole split is the hover text and
                // stays in the accessible text (sr-only), so nothing is lost.
                <span
                  className="whitespace-nowrap text-xs text-gray-500 dark:text-gray-400"
                  title={loadDetail(h, m)}
                  data-testid={`handoff-target-load-${m.id}`}
                >
                  {h.loadOpen.replace('{n}', String(m.open))}
                  {typeof m.overdue === 'number' && m.overdue > 0 && (
                    <span className="text-red-600 dark:text-red-400">
                      {' · '}
                      {h.loadOverdue.replace('{n}', String(m.overdue))}
                    </span>
                  )}
                  {m.followUps && (
                    <span className="sr-only" data-testid={`handoff-target-channels-${m.id}`}>
                      {' · '}
                      {h.loadChannels
                        .replace('{call}', String(m.followUps.call))
                        .replace('{email}', String(m.followUps.email))
                        .replace('{other}', String(m.followUps.other))}
                    </span>
                  )}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The load line in full, for the hover text: open, overdue and the split by channel. */
function loadDetail(h: { loadOpen: string; loadOverdue: string; loadChannels: string }, m: TeamMember): string {
  const parts = [h.loadOpen.replace('{n}', String(m.open ?? 0))];
  if (typeof m.overdue === 'number') parts.push(h.loadOverdue.replace('{n}', String(m.overdue)));
  if (m.followUps) {
    parts.push(
      h.loadChannels
        .replace('{call}', String(m.followUps.call))
        .replace('{email}', String(m.followUps.email))
        .replace('{other}', String(m.followUps.other)),
    );
  }
  return parts.join(' · ');
}

function LeadHandoffDialog({
  pending,
  members,
  onClose,
  onDone,
}: {
  pending: Pending | null;
  members: TeamMember[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const h = t.leadHandoff;
  const locale = useLocale();
  const toast = useToast();
  const open = pending !== null;
  const dialogRef = useModalFocus<HTMLDivElement>(open, onClose);
  const [recipientId, setRecipientId] = useState('');
  const [action, setAction] = useState<HandoffAction>('call');
  const [note, setNote] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Current | null>(null);
  // Keeping the current follow-up is the default (feedback, #3976): a new one is the exception.
  const [keep, setKeep] = useState(true);
  // The new step's images (#3932): drafts on this record, sent as `imageIds`.
  const drafts = useFollowUpImageDrafts(pending?.relationId ?? null);

  useEffect(() => {
    if (!pending) return;
    setRecipientId(pending.recipientId ?? '');
    setAction('call');
    setNote('');
    setDueOn(localDayFromToday(0));
    setDueAt('');
    setError(null);
    setKeep(true);
    setCurrent(null);
    drafts.reset([]);
    // Who has the record now, and the follow-up it carries (#3873). Read-only and
    // best effort: without it the dialog is what it was, minus the keep option.
    let alive = true;
    fetch(`/api/sales/leads/${pending.relationId}/handoff`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Current | null) => alive && setCurrent(d))
      .catch(() => alive && setCurrent(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on a new dialog only
  }, [pending]);

  if (!pending) return null;

  const recipient = members.find((m) => m.id === recipientId);
  const hasFollowUp = !!current && (!!current.nextActionAt || !!current.nextActionNote);
  const keeping = keep && hasFollowUp;
  const noteRequired = !keeping && followUpNoteMissing(action, note);
  const canSubmit = !!recipientId && recipientId !== current?.ownerId && !noteRequired && !busy && !drafts.uploading;
  // One follow-up as a phrase: its day (a calendar day at UTC midnight), its note, or both.
  const followUpText = current
    ? [
        current.nextActionAt
          ? formatDate(current.nextActionAt, locale, { timeZone: 'UTC' }) + (current.nextActionTime ? ` ${current.nextActionTime}` : '')
          : null,
        current.nextActionNote,
      ].filter(Boolean).join(' — ')
    : '';
  const title = pending.recipientId && recipient
    ? fill(h.dialogTitle, { lead: pending.leadName, name: recipient.fullName })
    : fill(h.dialogTitleNoRecipient, { lead: pending.leadName });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sales/leads/${pending.relationId}/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          keeping
            ? { toUserId: recipientId, action, keepFollowUp: true }
            : {
                toUserId: recipientId,
                action,
                note: note.trim() || null,
                dueOn: dueOn || null,
                dueAt: dueAt || null,
                ...(drafts.ids.length ? { imageIds: drafts.ids } : {}),
              },
        ),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = (h.errors as Record<string, string>)[body.code] ?? h.failed;
        setError(msg);
        return;
      }
      toast(fill(h.done, { lead: pending.leadName, name: recipient?.fullName ?? '' }), 'success');
      onDone();
    } catch {
      setError(h.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lead-handoff-title"
        data-testid="lead-handoff-dialog"
        tabIndex={-1}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="lead-handoff-title" className="mb-4 text-base font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h2>

        <div className="space-y-4">
          {current && (
            <p className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:bg-gray-900 dark:text-gray-300" data-testid="lead-handoff-current">
              {hasFollowUp
                ? fill(h.currentLine, { name: current.ownerName, followUp: followUpText })
                : fill(h.currentNoFollowUp, { name: current.ownerName })}
            </p>
          )}

          {!pending.recipientId && (
            <Select
              label={h.recipientLabel}
              required
              data-testid="lead-handoff-recipient"
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
              placeholder={h.recipientPlaceholder}
              options={members.map((m) => ({ value: m.id, label: m.self ? `${m.fullName} (${h.you})` : m.fullName }))}
            />
          )}

          {hasFollowUp && (
            <fieldset>
              <legend className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{h.followUpChoice}</legend>
              <div className="flex flex-col gap-1.5 text-sm text-gray-700 dark:text-gray-200" role="radiogroup">
                <label className="inline-flex items-center gap-2">
                  <input type="radio" name="lead-handoff-follow-up" checked={keep} onChange={() => setKeep(true)} data-testid="lead-handoff-follow-up-keep" />
                  {h.followUpKeep}
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="radio" name="lead-handoff-follow-up" checked={!keep} onChange={() => setKeep(false)} data-testid="lead-handoff-follow-up-new" />
                  {h.followUpNew}
                </label>
              </div>
            </fieldset>
          )}

          {/* Keeping the follow-up leaves nothing to write: the step fields go. */}
          {!keeping && (
            <>
              {/* The same editor as the record's follow-up panel (#3903). */}
              <FollowUpFields
                value={{ action, date: dueOn, time: dueAt, note }}
                onChange={(v) => {
                  if (v.action) setAction(v.action);
                  setDueOn(v.date);
                  setDueAt(v.date ? v.time : '');
                  setNote(v.note);
                }}
                idPrefix="lead-handoff"
                testIdPrefix="lead-handoff"
                actions
                quickDates
                disabled={busy}
                notePlaceholder={h.notePlaceholder}
                images={<FollowUpImagePicker drafts={drafts} testIdPrefix="lead-handoff" disabled={busy} />}
                onPasteImages={(files) => void drafts.add(files)}
              />
            </>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-600" data-testid="lead-handoff-error">
              {error}
            </p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose} data-testid="lead-handoff-cancel">
            {h.cancel}
          </Button>
          <Button type="button" variant="primary" loading={busy} disabled={!canSubmit} onClick={submit} data-testid="lead-handoff-confirm">
            {h.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The per-card button: the same dialog without a drag. */
export function HandoffCardButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="board-card-handoff"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="mt-2 inline-flex min-h-8 items-center gap-1 rounded text-xs text-gray-500 hover:text-blue-600 hover:underline"
    >
      <UserRoundPlus className="h-3.5 w-3.5" />
      {t.leadHandoff.cardButton}
    </button>
  );
}
