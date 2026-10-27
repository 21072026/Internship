'use client';

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_BOARD_WIP_LIMIT, resolveWipLimit } from '@/lib/boardWip';

// The board's WIP limits (#1439) as both boards read them (#2076): the org-wide
// default and the per-stage overrides, from the one read endpoint. Advisory
// decoration: a failed request leaves the shipped default in place rather than
// blanking the board or retrying.
export function useBoardWipLimits() {
  const [wipDefault, setWipDefault] = useState<number | null>(DEFAULT_BOARD_WIP_LIMIT);
  const [wipPerStage, setWipPerStage] = useState<Record<string, number | null>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/board/wip-limits');
      if (!res.ok) return;
      const data = await res.json();
      setWipDefault(data.defaultWipLimit ?? null);
      setWipPerStage(data.stages ?? {});
    } catch {
      /* keep the default */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return useCallback(
    (status: string) => resolveWipLimit(status, wipDefault, wipPerStage),
    [wipDefault, wipPerStage]
  );
}
