// Types for the CommonJS policy builder shared with next.config.js (#1552).
declare module '@/lib/cspPolicy.cjs' {
  export function buildCsp(
    env: Record<string, string | undefined>,
    opts?: { nonce?: string; dev?: boolean },
  ): string;
  export const CSP_REPORT_PATH: string;
  export const JAAS: string;
}
