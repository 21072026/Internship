// Is this request the native app's in-app web view? (#2775)
//
// The app's WebView appends `InternCRMApp/<n>` to its User-Agent
// (apps/mobile/src/components/WebScreen.tsx). The root layout then renders
// <html data-embedded-app>, and the site's own top bar, drawer and install
// prompt (marked data-app-chrome) step aside — the app draws those natively.
//
// Rendered by the SERVER on purpose: an attribute the app's web view set from
// script before load was stripped again by React's hydration of <html>, so the
// chrome flashed back. A forged User-Agent only hides the visitor's own chrome
// on their own screen — it grants and reveals nothing — so this is presentation,
// never access control.
export const EMBEDDED_APP_UA_MARKER = 'InternCRMApp/';

export function isEmbeddedAppUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === 'string' && userAgent.includes(EMBEDDED_APP_UA_MARKER);
}
