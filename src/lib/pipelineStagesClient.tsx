'use client';

import { createContext, useContext } from 'react';
import { defaultPipelineStages, stageLabel, onPathKeys, type ResolvedStage } from '@/lib/pipeline';
import { useLocale } from '@/i18n/client';

// Client access to the viewer's tenant pipeline stages (#747, Slice B). The
// server layout resolves the org's CUSTOM stages (or null when it uses the
// built-in defaults) and provides them here; client components read them via the
// hooks below. When null, we compute the canonical defaults in the *client*
// locale, so default-stage labels stay localized while custom labels (a single
// tenant-set string) render as-is.

const Ctx = createContext<ResolvedStage[] | null>(null);

export function PipelineStagesProvider({
  stages,
  children,
}: {
  stages: ResolvedStage[] | null;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={stages}>{children}</Ctx.Provider>;
}

// The viewer's resolved stages (custom if set, else localized defaults).
export function useResolvedStages(): ResolvedStage[] {
  const locale = useLocale();
  const ctx = useContext(Ctx);
  return ctx && ctx.length > 0 ? ctx : defaultPipelineStages(locale);
}

// A label(key) resolver bound to the viewer's stages + locale.
export function useStageLabel(): (key: string) => string {
  const locale = useLocale();
  const stages = useResolvedStages();
  return (key: string) => stageLabel(stages, key, locale);
}

export { onPathKeys, type ResolvedStage };
