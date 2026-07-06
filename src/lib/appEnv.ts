// Which deployment this build is running as. Baked in at build time via the
// NEXT_PUBLIC_APP_ENV build-arg (see Dockerfile + deploy.yml), so it is safe to
// read in both server and client components. Defaults to 'production' locally.
export type AppEnv = 'production' | 'preview';

export const APP_ENV: AppEnv =
  process.env.NEXT_PUBLIC_APP_ENV === 'preview' ? 'preview' : 'production';

// The preview deployment gets a distinct green accent + a "preview" badge so it
// is impossible to confuse with production (which stays blue).
export const IS_PREVIEW = APP_ENV === 'preview';
