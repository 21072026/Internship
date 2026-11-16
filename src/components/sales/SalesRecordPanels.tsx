'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { FollowUpPanel } from '@/components/FollowUpPanel';
import { TrialEndPanel } from '@/components/TrialEndPanel';
import { ContractEndPanel } from '@/components/ContractEndPanel';
import { WinBackPanel } from '@/components/WinBackPanel';
import { DealValuePanel, type DealValueState } from '@/components/DealValuePanel';
import { LostTrialOpenNotice } from '@/components/LostTrialOpen';
import { openInteractionDraft } from './interactionDraft';

// The editors a sales rep has on their own record (#2580): the follow-up
// (#2563, PUT /api/mentorship/[id] — owner or ADMIN) and the trial end (#2553,
// PATCH /api/mentorship/[id]/trial — owner or ADMIN, `pipeline` capability).
// The page around them is a server component, so a save refreshes it — the
// badges and the attention queue are server-rendered.
//
// Layout (#3737, two columns since #3803): the left column is what the rep does —
// the follow-up (what comes next) and the interactions (what already happened,
// `interactions`), the "action strip". The right column is what the record is —
// the date and value panels (trial end, win-back, contract end, estimated value)
// and the contact card (`contact`), stacked. The columns grow independently, so a
// long interaction list leaves no hole beside the short cards. On a phone it is
// one column in that order. A panel that does not render for the record's stage
// is `empty:hidden`, so it leaves no gap in its column.
// The follow-up offers quick dates (#3739) and "Complete" (#3740), which opens
// the interaction form with the follow-up's note as a call.
export function SalesRecordPanels({
  relationId,
  status,
  pipelineStatus,
  nextActionAt,
  nextActionNote,
  trialStartedAt,
  trialEndsAt,
  contractEndsAt,
  canEditTrial,
  stageName,
  dealValue,
  interactions,
  contact,
  readOnly = false,
  showFollowUp = true,
}: {
  relationId: string;
  status: string;
  pipelineStatus: string;
  nextActionAt: string | null;
  nextActionNote: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  contractEndsAt: string | null;
  /** Who may move the trial end, decided on the server (owner, dispatcher, admin — the trial route's rule). */
  canEditTrial: boolean;
  /** The current stage as the tenant labels it (the trial end's lock reason). */
  stageName: string;
  dealValue: DealValueState;
  /** The interactions card, beside the follow-up. */
  interactions: ReactNode;
  /** The contact card, last cell of the grid below. */
  contact?: ReactNode;
  /**
   * The team view's colleague record (decided on the server, salesBookWriteAllowed):
   * the values it may see read, no editor or action renders, and the deal value is
   * not shown (it is the owner's, like on GET /api/sales/team-book). The routes
   * refuse every write anyway.
   */
  readOnly?: boolean;
  /** The follow-up and the notice period are the owner's (canSeeNextAction): hidden, not shown empty, for anyone else. */
  showFollowUp?: boolean;
}) {
  const router = useRouter();
  const refresh = () => router.refresh();
  return (
    <div className="mb-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-6" data-testid="sales-lead-action-strip">
        {/* Marked lost while the trial still runs (#3813): first, it decides what the rest means. */}
        <div className="empty:hidden">
          <LostTrialOpenNotice
            relationId={relationId}
            record={{ pipelineStatus, status, trialEndsAt }}
            canRestore={!readOnly}
            onRestored={refresh}
          />
        </div>
        {showFollowUp && (
        <FollowUpPanel
          relationId={relationId}
          nextActionAt={nextActionAt}
          nextActionNote={nextActionNote}
          pipelineStatus={pipelineStatus}
          onSaved={refresh}
          quickDates
          readOnly={readOnly}
          onComplete={
            !readOnly && status === 'ACTIVE'
              ? (note, clear) => openInteractionDraft({ type: 'Call', notes: note ?? '', onLogged: clear })
              : undefined
          }
        />
        )}
        {interactions}
      </div>
      <div className="flex min-w-0 flex-col gap-6" data-testid="sales-record-panels-grid">
        {/* Nothing renders outside a trial. */}
        <div className="empty:hidden">
          <TrialEndPanel
            relationId={relationId}
            pipelineStatus={pipelineStatus}
            trialStartedAt={trialStartedAt}
            trialEndsAt={trialEndsAt}
            canEdit={!readOnly && canEditTrial}
            readFirst
            status={status}
            stageName={stageName}
            onSaved={refresh}
          />
        </div>
        {/* A lost customer came back (#2842); renders on an open DEAL_LOST record only. */}
        {!readOnly && (
        <div className="empty:hidden">
          <WinBackPanel
            relationId={relationId}
            pipelineStatus={pipelineStatus}
            status={status}
            hrefFor={(id) => `/sales/leads/${id}`}
          />
        </div>
        )}
        {/* A won customer's notice period (#2841); renders on DEAL_WON only — the owner's, like the follow-up. */}
        {showFollowUp && (
        <div className="empty:hidden">
          <ContractEndPanel
            relationId={relationId}
            pipelineStatus={pipelineStatus}
            contractEndsAt={contractEndsAt}
            canEdit={!readOnly && status === 'ACTIVE'}
            onSaved={refresh}
          />
        </div>
        )}
        {/* The estimated monthly value (#2422, PUT /api/mentorship/[id]/value —
            owner or ADMIN). */}
        {!readOnly && (
          <div>
            <DealValuePanel relationId={relationId} initial={dealValue} onSaved={refresh} />
          </div>
        )}
        {contact && <div className="empty:hidden">{contact}</div>}
      </div>
    </div>
  );
}
