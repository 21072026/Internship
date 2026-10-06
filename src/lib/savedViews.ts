// Saved views (#1900) — client-safe: the surfaces, the visibilities and the
// shape a view's filters may take. The routes (src/app/api/admin/saved-views)
// enforce who may read and change a view; this file only says what a view is.

/** Every admin list a view can be saved on. A new list adds its key here. */
export const SAVED_VIEW_SURFACES = ['candidates', 'mentorship', 'board', 'mentors', 'companies', 'requisitions', 'users', 'analytics'] as const;
export type SavedViewSurface = (typeof SAVED_VIEW_SURFACES)[number];

export const SAVED_VIEW_VISIBILITIES = ['PRIVATE', 'ORG'] as const;
export type SavedViewVisibility = (typeof SAVED_VIEW_VISIBILITIES)[number];

export const MAX_VIEW_NAME = 80;
const MAX_FILTER_KEYS = 30;
const MAX_FILTER_VALUE = 500;

export function isSavedViewSurface(value: unknown): value is SavedViewSurface {
  return typeof value === 'string' && (SAVED_VIEW_SURFACES as readonly string[]).includes(value);
}

/**
 * A view's filters as stored: string → string, at most 30 keys, every value
 * capped. Anything else is dropped rather than refused — a list page's own
 * state is the source, and a view is only ever applied back to that page.
 */
export function sanitizeViewFilters(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_FILTER_KEYS) break;
    if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    out[key] = String(value).slice(0, MAX_FILTER_VALUE);
  }
  return out;
}

export interface SavedViewDto {
  id: string;
  name: string;
  filters: Record<string, string>;
  visibility: SavedViewVisibility;
  /** True when the viewer wrote it — the only one who may rename, share or delete it. */
  mine: boolean;
  author: string | null;
}

/** A stored view as the API returns it to `viewerId`. */
export function toSavedViewDto(
  view: { id: string; name: string; filters: unknown; visibility: string; createdById: string; createdBy: { fullName: string } | null },
  viewerId: string,
): SavedViewDto {
  return {
    id: view.id,
    name: view.name,
    filters: sanitizeViewFilters(view.filters),
    visibility: view.visibility === 'ORG' ? 'ORG' : 'PRIVATE',
    mine: view.createdById === viewerId,
    author: view.createdBy?.fullName ?? null,
  };
}
