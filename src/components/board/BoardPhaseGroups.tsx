'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useT } from '@/i18n/client';
import type { PipelineGroupKey } from '@/lib/pipeline';
import { HorizontalScrollArea } from '@/components/board/HorizontalScrollArea';

type Group = { key: PipelineGroupKey; statuses: string[] };

// The board's collapsible phases (#422, shared since #2076): the stages of
// groupResolvedStages() under one header per phase, each header a toggle with
// the phase's card count. Built from the resolved stages (#828), so a tenant's
// custom stages get their own "custom" group rather than being dropped.
//
// Two layouts, one behaviour:
//   stacked — the admin board: one phase under another, each its own
//             horizontal scroller (`board-scroll-<group>`). Returns the sections
//             bare, so the caller's container spaces them.
//   row     — the owner's board: the phases side by side in ONE scroller
//             (`testId`). A mentor holds a handful of cards; stacked phases put
//             the outcome phase below the fold, which is what #1366 removed.
export function BoardPhaseGroups({
  groups,
  countFor,
  renderColumns,
  hideEmpty = false,
  layout = 'stacked',
  testId,
}: {
  groups: Group[];
  /** Cards on one stage, after any search — the phase total sums these. */
  countFor: (status: string) => number;
  renderColumns: (statuses: string[]) => ReactNode;
  /** Drop empty stages, and a phase with no cards at all. */
  hideEmpty?: boolean;
  layout?: 'stacked' | 'row';
  /** The row layout's scroller. */
  testId?: string;
}) {
  const t = useT();
  // Keyed by group, but by a plain string: a tenant with custom stages gets a
  // "custom" group that isn't one of the three built-ins, and an unvisited key
  // reads as undefined → expanded, which is the wanted default anyway.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleGroup = (key: PipelineGroupKey) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  const sections = groups.map((group) => {
    const statuses = hideEmpty ? group.statuses.filter((s) => countFor(s) > 0) : group.statuses;
    const groupTotal = group.statuses.reduce((n, s) => n + countFor(s), 0);
    if (hideEmpty && groupTotal === 0) return null;
    const isCollapsed = collapsed[group.key];
    const header = (
      <button
        type="button"
        onClick={() => toggleGroup(group.key)}
        aria-expanded={!isCollapsed}
        data-testid={`board-group-${group.key}`}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {isCollapsed ? <ChevronRight className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
        <span className="text-sm font-semibold text-gray-800 whitespace-nowrap">
          {(t.adminBoard.groups as Record<string, string>)[group.key]}
        </span>
        {/* gray-700, not the muted token: this chip carries its own
            gray-100 background, and even the raised gray-500 only makes
            4.4:1 on it (4.1:1 on the dark remap) — #2131. */}
        <span className="text-xs text-gray-700 bg-gray-100 rounded-full px-2 py-0.5">{groupTotal}</span>
      </button>
    );
    if (layout === 'row') {
      return (
        <section key={group.key} className="flex-shrink-0 rounded-xl border border-gray-100 bg-white/40">
          {header}
          {!isCollapsed && <div className="flex gap-3 px-2 pb-2">{renderColumns(statuses)}</div>}
        </section>
      );
    }
    return (
      <section key={group.key} className="rounded-xl border border-gray-100 bg-white/40">
        {header}
        {!isCollapsed && (
          <HorizontalScrollArea
            testId={`board-scroll-${group.key}`}
            label={t.a11y.scrollableColumns}
            className="flex gap-4 px-3 pb-4"
          >
            {renderColumns(statuses)}
          </HorizontalScrollArea>
        )}
      </section>
    );
  });

  if (layout === 'row') {
    return (
      <HorizontalScrollArea testId={testId} label={t.a11y.scrollableColumns} className="flex items-start gap-3 pb-4">
        {sections}
      </HorizontalScrollArea>
    );
  }
  return <>{sections}</>;
}
