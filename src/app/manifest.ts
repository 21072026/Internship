import type { MetadataRoute } from 'next';

// Web app manifest (served at /manifest.webmanifest) — makes the app
// installable on desktop and mobile.
//
// Single-language on purpose (#2084): a manifest is fetched once, before the
// app has any idea who is reading it, and there is no per-locale manifest URL —
// so the few strings here stay English, while everything a signed-in person
// reads (including /share, the share target below) goes through the EN/TR/DE
// dictionaries as usual.
export default function manifest(): MetadataRoute.Manifest {
  return {
    // A stable identity for the installed app, independent of where it is
    // hosted: without `id`, the browser derives one from start_url, so a change
    // of start_url would look like a *different* app and re-prompt everyone.
    id: '/',
    name: 'Internship CRM',
    short_name: 'InternshipCRM',
    description: 'Mentor ↔ mentee CRM & internship pipeline',
    lang: 'en',
    dir: 'ltr',
    categories: ['business', 'productivity', 'education'],
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // Fall back to minimal-ui (a browser frame with a URL bar) where standalone
    // is not available, rather than all the way down to a normal tab.
    display_override: ['standalone', 'minimal-ui'],
    background_color: '#ffffff',
    theme_color: '#1D4ED8',
    // Deliberately *not* locked to portrait (#2084): the pipeline board is a
    // wide horizontal scroller and the analytics tables are wide too, so a
    // tablet held in landscape must stay in landscape. 'any' follows the device.
    orientation: 'any',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    // Long-press the installed icon. Only role-neutral destinations belong
    // here: the manifest is static and cannot branch on who is signed in, so
    // /admin, /mentor and /portal are all wrong for two thirds of the users.
    // Each of these three guards itself with a sign-in redirect that carries a
    // ?callbackUrl, so a tap while signed out lands back on the right screen.
    shortcuts: [
      {
        name: 'Messages',
        short_name: 'Messages',
        description: 'Open your conversations',
        url: '/messages',
        icons: [{ src: '/shortcut-messages-96.png', sizes: '96x96', type: 'image/png' }],
      },
      {
        name: 'To-dos',
        short_name: 'To-dos',
        description: 'Everything on your list',
        url: '/todos',
        icons: [{ src: '/shortcut-todos-96.png', sizes: '96x96', type: 'image/png' }],
      },
      {
        name: 'Notifications',
        short_name: 'Alerts',
        description: 'What happened while you were away',
        url: '/notifications',
        icons: [{ src: '/shortcut-notifications-96.png', sizes: '96x96', type: 'image/png' }],
      },
    ],
    // Share a link from another app into this one. GET only, and /share never
    // writes anything from the URL: it shows what was shared and waits for an
    // explicit confirmation (a share target that acted on its parameters would
    // be a one-click CSRF from any app on the phone).
    share_target: {
      action: '/share',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    },
    // `screenshots` — what turns the install prompt into a rich card — are
    // deliberately absent until #1399 lands the capture pipeline that writes
    // public/screenshots/ from the demo seed. A manifest that points at images
    // which do not exist is worse than one without them, and no screenshot may
    // ever be taken from real or preview data (docs/DATA_ACCESS_POLICY.md).
  };
}
