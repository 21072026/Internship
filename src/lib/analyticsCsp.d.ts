// Types for the CommonJS host table shared with next.config.js.
declare module '@/lib/analyticsCsp.cjs' {
  export function analyticsCspHosts(env?: Record<string, string | undefined>): {
    script: string[];
    connect: string[];
  };
}
