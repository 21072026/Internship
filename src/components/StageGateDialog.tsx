'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { useT } from '@/i18n/client';
import type { GateFailure } from '@/lib/stageGateRule';

// The refusal of a gated stage move (#1590), rendered where a person moved the
// card: both boards and the candidate page. The server's
// `409 { error: 'stage_gate_blocked', gate }` (src/lib/stageGate.ts) names
// what is missing; this says it in the viewer's language and, for documents,
// links to where they are uploaded — a blocked move the mover can act on,
// instead of a "move failed" toast.

/** The gate of a refused move, or null for any other response. Reads the body only on a 409. */
export async function stageGateFrom(res: Response): Promise<GateFailure | null> {
  if (res.status !== 409) return null;
  const data = await res.json().catch(() => null);
  return data?.error === 'stage_gate_blocked' && data.gate ? (data.gate as GateFailure) : null;
}

interface Shown {
  gate: GateFailure;
  stageLabel: string;
  /** Where the mentee's documents are, for a documents refusal. */
  documentsHref?: string;
}

export function useStageGateDialog() {
  const [shown, setShown] = useState<Shown | null>(null);
  const show = useCallback((value: Shown) => setShown(value), []);
  const close = useCallback(() => setShown(null), []);
  return { show, dialog: <StageGateDialog shown={shown} onClose={close} /> };
}

function StageGateDialog({ shown, onClose }: { shown: Shown | null; onClose: () => void }) {
  const t = useT();
  const L = t.stageGate;
  const ref = useModalFocus<HTMLDivElement>(!!shown, onClose);
  if (!shown) return null;
  const { gate, stageLabel, documentsHref } = shown;
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stage-gate-title"
        data-testid="stage-gate-dialog"
        data-code={gate.code}
        tabIndex={-1}
        className="w-full max-w-md rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="stage-gate-title" className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {L.title}
        </h2>
        <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
          <p>{L.intro.replace('{stage}', stageLabel)}</p>
          {gate.code === 'capability' && <p data-testid="stage-gate-reason">{L.capability}</p>}
          {gate.code === 'evaluation' && <p data-testid="stage-gate-reason">{L.evaluation}</p>}
          {gate.code === 'offer' && <p data-testid="stage-gate-reason">{L.offer}</p>}
          {gate.code === 'documents' && (
            <>
              <p data-testid="stage-gate-reason">{L.documents}</p>
              <ul className="list-disc pl-5" data-testid="stage-gate-missing">
                {(gate.missing ?? []).map((m) => (
                  <li key={m.key}>{m.label}</li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {gate.code === 'documents' && documentsHref && (
            <Link
              href={documentsHref}
              onClick={onClose}
              data-testid="stage-gate-documents-link"
              className="inline-flex items-center rounded-lg border border-blue-600 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-300"
            >
              {L.openDocuments}
            </Link>
          )}
          <Button type="button" variant="secondary" onClick={onClose} data-testid="stage-gate-close">
            {L.close}
          </Button>
        </div>
      </div>
    </div>
  );
}
