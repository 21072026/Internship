'use client';

import { useCallback, useEffect, useState } from 'react';
import { UserRoundPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';
import { HANDOFF_ACTIONS, HANDOFF_NOTE_MAX, todayIso, type HandoffAction } from '@/lib/leadHandoffRule';

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
}

interface Pending {
  relationId: string;
  leadName: string;
  recipientId: string | null;
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
}) {
  const { includeSelf, nameOf, onHandedOff } = opts;
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
    strip: enabled ? <LeadHandoffStrip members={members} onDrop={(memberId, relationId) => open(relationId, memberId)} /> : null,
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

function LeadHandoffStrip({ members, onDrop }: { members: TeamMember[]; onDrop: (memberId: string, relationId: string) => void }) {
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
        {h.stripLabel} · <span className="font-normal">{h.stripHint}</span>
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
            <span className="whitespace-nowrap">
              {m.fullName}
              {m.self && <span className="ml-1 text-xs text-gray-400">({h.you})</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
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
  const toast = useToast();
  const open = pending !== null;
  const dialogRef = useModalFocus<HTMLDivElement>(open, onClose);
  const [recipientId, setRecipientId] = useState('');
  const [action, setAction] = useState<HandoffAction>('call');
  const [note, setNote] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pending) return;
    setRecipientId(pending.recipientId ?? '');
    setAction('call');
    setNote('');
    setDueOn(todayIso());
    setError(null);
  }, [pending]);

  if (!pending) return null;

  const recipient = members.find((m) => m.id === recipientId);
  const noteRequired = action === 'other';
  const canSubmit = !!recipientId && (!noteRequired || note.trim().length > 0) && !busy;
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
        body: JSON.stringify({ toUserId: recipientId, action, note: note.trim() || null, dueOn: dueOn || null }),
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
        className="w-full max-w-md rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="lead-handoff-title" className="mb-4 text-base font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h2>

        <div className="space-y-4">
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

          <fieldset>
            <legend className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{h.actionLabel}</legend>
            <div className="flex flex-wrap gap-2" role="radiogroup">
              {HANDOFF_ACTIONS.map((a) => (
                <label
                  key={a}
                  className={`inline-flex min-h-11 cursor-pointer items-center rounded-lg border px-3 text-sm ${
                    action === a
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200'
                  }`}
                >
                  <input
                    type="radio"
                    name="lead-handoff-action"
                    value={a}
                    checked={action === a}
                    onChange={() => setAction(a)}
                    data-testid={`lead-handoff-action-${a}`}
                    className="sr-only"
                  />
                  {h.actions[a]}
                </label>
              ))}
            </div>
          </fieldset>

          <Textarea
            aria-label={h.noteLabel}
            data-testid="lead-handoff-note"
            placeholder={noteRequired ? h.notePlaceholderOther : h.notePlaceholder}
            maxLength={HANDOFF_NOTE_MAX}
            required={noteRequired}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <Input
            id="lead-handoff-due"
            type="date"
            label={h.dueLabel}
            data-testid="lead-handoff-due"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
          />

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
