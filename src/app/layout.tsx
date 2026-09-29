import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import './globals.css';
import { Providers } from './providers';
import { getLocale } from '@/i18n/server';
import { getDictionary, toClientDictionary } from '@/i18n/dictionaries';
import { resolveRequestVertical } from '@/i18n/server';
import { applyVerticalOverlay } from '@/i18n/verticalOverlays';
import { productNameFor } from '@/lib/verticals';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hasSessionCookie } from '@/lib/sessionCookie';
import { resolveAccent, themeColorFor } from '@/lib/accent';
import { DENSITY_CLASS, resolveDensity } from '@/lib/density';
import { IS_DEMO_MODE } from '@/lib/demoMode';
import { DemoModeBanner } from '@/components/DemoModeBanner';
import { SystemThemeSync } from '@/components/SystemThemeSync';
import { ServiceWorkerRegistrar } from '@/components/ServiceWorkerRegistrar';
import { appleSplashLinks } from '@/lib/appleSplash';

// Vertical-aware tab title / app name (#2498). INTERNSHIP is byte-identical to
// the previous static metadata (several landing e2e specs assert the exact
// title), so only a marketing host/tenant reads its own product name instead of
// "Internship CRM". resolveRequestVertical is session-first, host-second, so it
// is right both signed-in (org vertical) and signed-out (host vertical).
export async function generateMetadata(): Promise<Metadata> {
  const vertical = await resolveRequestVertical();
  const isMarketing = vertical === 'MARKETING';
  const productName = productNameFor(vertical);
  return {
  title: isMarketing ? `${productName} — Marketing CRM` : 'Internship CRM - Mentor-Mentee Management',
  description: isMarketing
    ? 'A CRM for tracking customers through a marketing pipeline — from first contact to close.'
    : 'A comprehensive CRM for managing mentor-mentee relationships and internship programs',
  applicationName: productName,
  appleWebApp: { capable: true, statusBarStyle: 'default', title: productName },
  // The favicon / home-screen icon follow the vertical too (#2492). Both SVGs
  // live in public/: the file-based app/icon.svg convention cannot branch on
  // the host, and Next ignores it anyway once `icons` is set here. Each branch
  // carries a raster fallback after the SVG — Safari loads no SVG favicon and
  // would otherwise fall through to the implicit /favicon.ico, which is the
  // internship cap on both hosts.
  icons: {
    icon: isMarketing
      ? [
          { url: '/icon-salevali.svg', type: 'image/svg+xml' },
          { url: '/icon-salevali-192.png', type: 'image/png', sizes: '192x192' },
        ]
      : [
          { url: '/icon.svg', type: 'image/svg+xml' },
          { url: '/favicon.ico', sizes: 'any' },
        ],
    apple: isMarketing ? '/apple-touch-icon-salevali.png' : '/apple-touch-icon.png',
    // iOS launch screens for the installed app (#2084). Safari ignores the
    // manifest here and wants one media-matched <link> per device resolution,
    // so the list — and the images under public/splash/ — are both generated
    // from the device table in lib/appleSplash.ts. One set per product mark.
    other: appleSplashLinks(isMarketing ? 'salevali' : ''),
  },
  };
}

// The browser-UI tint follows the vertical (#2492) — `themeColorFor` is the
// one place the two colours live, shared with the /messages viewport and the
// manifest. resolveRequestVertical is cached per request, so this is free.
export async function generateViewport(): Promise<Viewport> {
  const vertical = await resolveRequestVertical();
  return {
  themeColor: themeColorFor(vertical),
  // Shrink the layout viewport when the on-screen keyboard opens instead of
  // letting it overlay the page, so a full-height screen (the chat shell, #1006)
  // keeps its composer above the keyboard rather than behind it.
  interactiveWidget: 'resizes-content',
  };
}

// Runs before paint to set the dark class from the saved preference or the OS,
// so there's no light flash. Mirrors the server-side cookie read below.
// `theme=system` is an explicit stored value (#2078), not the absence of one:
// it is resolved here through matchMedia, which is why SSR can leave the class
// off and this script still paints the right theme on the first frame.
const NO_FLASH = `(function(){try{var h=document.documentElement;var p=function(n,a){var m=document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]+)'));if(m)return decodeURIComponent(m[1]);var v=null;try{v=localStorage.getItem(n);}catch(e){}return v||h.getAttribute(a);};var e=p('theme','data-theme-pref');var d;if(e==='dark')d=true;else if(e==='light')d=false;else d=!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);h.classList.toggle('dark',d);var fe=p('fontSize','data-font-size-pref');if(fe==='sm'||fe==='lg'||fe==='xl')h.classList.add('font-'+fe);h.classList.toggle('density-compact',p('density','data-density-pref')==='compact');}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  // Same vertical overlay the server dictionary gets (#2354), so the client
  // payload and server render agree. INTERNSHIP resolves to an empty overlay,
  // so this is identical to the base client dict for today's product.
  //
  // Overlay FIRST, strip after (#2475): the deep merge ADDS a namespace the
  // base does not have, so stripping first meant every server-only namespace
  // the overlay touches — `landing` above all — was merged back into the
  // browser payload on a marketing host.
  const vertical = await resolveRequestVertical();
  const dict = toClientDictionary(applyVerticalOverlay(getDictionary(locale), locale, vertical));
  const cookieStore = await cookies();
  let theme = cookieStore.get('theme')?.value;
  let fontSize = cookieStore.get('fontSize')?.value;
  let accent = cookieStore.get('accent')?.value;
  let density = cookieStore.get('density')?.value;
  // No device cookie yet? Fall back to the signed-in user's saved preferences
  // so they follow them across devices (the no-flash script still handles OS default).
  // Signed-out visitors have none, and this layout wraps every page — so gate on
  // the session cookie rather than paying a session decode per view (#1197).
  if ((!theme || !fontSize || !accent || !density) && (await hasSessionCookie())) {
    try {
      const session = await getServerSession(authOptions);
      if (session?.user?.id) {
        const u = await prisma.user.findUnique({ where: { id: session.user.id }, select: { theme: true, fontSize: true, accentColor: true, density: true } });
        if (!theme && u?.theme) theme = u.theme;
        if (!fontSize && u?.fontSize) fontSize = u.fontSize;
        if (!accent && u?.accentColor) accent = u.accentColor;
        if (!density && u?.density) density = u.density;
      }
    } catch { /* ignore */ }
  }
  const fontSizeClass = fontSize === 'sm' || fontSize === 'lg' || fontSize === 'xl' ? `font-${fontSize}` : undefined;
  const densityClass = resolveDensity(density) === 'compact' ? DENSITY_CLASS : undefined;

  return (
    <html
      lang={locale}
      className={[theme === 'dark' ? 'dark' : undefined, fontSizeClass, densityClass].filter(Boolean).join(' ') || undefined}
      data-accent={resolveAccent(accent, vertical)}
      // The preferences this request resolved (cookie, else the signed-in
      // user's saved value). The no-flash script falls back to these when the
      // device itself has stored nothing, so a preference that lives only in
      // the account still paints correctly on the first frame instead of being
      // overruled by the OS setting.
      data-theme-pref={theme || undefined}
      data-font-size-pref={fontSize || undefined}
      data-density-pref={density || undefined}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:rounded-lg focus:bg-blue-600 focus:px-4 focus:py-2 focus:text-white"
        >
          {dict.a11y.skipToContent}
        </a>
        {/* Keeps a `system` theme preference following the OS while the tab
            is open (#2078). Renders nothing. */}
        <SystemThemeSync />
        {/* Registers /sw.js on every route, signed in or not (#1550) — the
            offline fallback and the install prompt used to exist only behind
            login. Renders nothing. */}
        <ServiceWorkerRegistrar />
        <Providers locale={locale} dict={dict} vertical={vertical}>
          {/* Public demo (#966) — above everything, on every route, so a visitor
              never mistakes the demo for their own tenant. */}
          {IS_DEMO_MODE && <DemoModeBanner />}
          {children}
        </Providers>
      </body>
    </html>
  );
}
