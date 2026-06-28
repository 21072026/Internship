import type { MetadataRoute } from 'next';

// Web app manifest (served at /manifest.webmanifest) — makes the app
// installable on desktop and mobile.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Internship CRM',
    short_name: 'InternshipCRM',
    description: 'Mentor ↔ mentee CRM & internship pipeline',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1D4ED8',
    orientation: 'portrait-primary',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };
}
