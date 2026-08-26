// Ambient types for swagger-ui-dist (#1447).
//
// The package ships no TypeScript declarations and no @types package we want to
// pull in, so `npx tsc --noEmit` (a required CI step) would fail on the two
// imports the API explorer needs. Declaring exactly those two module specifiers
// keeps the surface honest: the config object is genuinely open-ended (Swagger
// UI reads ~40 optional options plus plugin hooks), and the only thing we call
// back on the returned system is `preauthorizeApiKey`.
//
// Only the ES bundle is declared on purpose — the UMD `swagger-ui-bundle.js`
// and the standalone preset are deliberately not used (the standalone layout
// renders a spec-URL bar, which would let the page point at an off-origin spec).

declare module 'swagger-ui-dist/swagger-ui.css';

declare module 'swagger-ui-dist/swagger-ui-es-bundle.js' {
  /**
   * The subset of Swagger UI's returned "system" the explorer drives
   * imperatively. `preauthorizeApiKey(schemeName, value)` fills the Authorize
   * dialog for an `apiKey` or `http`-bearer security scheme without the user
   * pasting anything. It returns exactly `null` when the spec has no security
   * scheme by that name — a silent no-op we check for rather than claiming the
   * dialog was filled.
   */
  export interface SwaggerUISystem {
    preauthorizeApiKey?: (schemeName: string, value: string) => unknown;
  }

  const SwaggerUIBundle: (options: Record<string, unknown>) => SwaggerUISystem;
  export default SwaggerUIBundle;
}
