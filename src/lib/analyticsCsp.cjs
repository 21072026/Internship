// CommonJS mirror of the CSP half of src/lib/analytics.ts, for next.config.js.
//
// next.config.js is loaded by Node before any TS toolchain exists, so it cannot
// import the TypeScript module. Rather than duplicate the provider table, this
// file owns the ONE fact the config needs — which hosts each provider talks to
// — and src/lib/analytics.ts imports it back, so there is still a single list.
const PROVIDERS = {
  plausible: {
    env: 'NEXT_PUBLIC_PLAUSIBLE_DOMAIN',
    hosts: (env) => {
      const host = env.NEXT_PUBLIC_PLAUSIBLE_HOST || 'https://plausible.io';
      return { script: [host], connect: [host] };
    },
  },
  ga4: {
    env: 'NEXT_PUBLIC_GA4_MEASUREMENT_ID',
    hosts: () => ({
      script: ['https://www.googletagmanager.com'],
      connect: ['https://www.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com'],
    }),
  },
  posthog: {
    env: 'NEXT_PUBLIC_POSTHOG_KEY',
    hosts: (env) => {
      const host = env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com';
      return { script: [host], connect: [host] };
    },
  },
};

function analyticsCspHosts(env = process.env) {
  const script = [];
  const connect = [];
  for (const p of Object.values(PROVIDERS)) {
    if (!env[p.env]) continue;
    const h = p.hosts(env);
    script.push(...h.script);
    connect.push(...h.connect);
  }
  return { script: [...new Set(script)], connect: [...new Set(connect)] };
}

module.exports = { PROVIDERS, analyticsCspHosts };
