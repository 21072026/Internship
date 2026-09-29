// The admin shell for the few /admin pages that must answer a real HTTP 404
// (#2560). It IS the admin layout — same session gate, same sidebar — re-exported,
// not copied, so the two can never drift.
//
// Why a second tree at all: src/app/admin/loading.tsx wraps every page under
// src/app/admin in a Suspense boundary, so the shell (status line included) is
// on the wire before the page runs. A page that calls notFound() there can only
// swap in the not-found UI under a 200. The pages in this route group have no
// loading.tsx above them, so their lookup runs before the first byte and
// notFound() is a 404 — "another tenant's account is a 404" (#2542) held at the
// HTTP level, not just on screen. The price is no skeleton while they render.
//
// Put a page here only for that reason; everything else belongs in
// src/app/admin and keeps its loading skeleton. The URL is the same either way
// (a route group adds no segment).
export { default } from '@/app/admin/layout';
