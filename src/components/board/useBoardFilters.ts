'use client';

import { useState } from 'react';

// The filter state both boards share (#2076): the search text and whether
// empty stages are hidden. State only — each board draws its own controls and
// decides what an empty stage looks like (the admin board drops it, the owner's
// board folds it into a narrow drop strip, #1366).
export function useBoardFilters(initial?: { search?: string; hideEmpty?: boolean }) {
  const [search, setSearch] = useState(initial?.search ?? '');
  const [hideEmpty, setHideEmpty] = useState(initial?.hideEmpty ?? false);
  return { search, setSearch, hideEmpty, setHideEmpty };
}
