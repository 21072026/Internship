import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import './globals.css';
import { Providers } from './providers';
import { getLocale } from '@/i18n/server';
import { getClientDictionary } from '@/i18n/dictionaries';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hasSessionCookie } from '@/lib/sessionCookie';
import { resolveAccent } from '@/lib/accent';
import { DENSITY_CLASS, resolveDensity } from '@/lib/density';
import { IS_DEMO_MODE } from '@/lib/demoMode';
import { DemoModeBanner } from '@/components/DemoModeBanner';
import { SystemThemeSync } from '@/components/SystemThemeSync';

export const metadata: Metadata = {
  title: 'Internship CRM - Mentor-Mentee Management',
  description: 'A comprehensive CRM for managing mentor-mentee relationships and internship programs',
  applicationName: 'Internship CRM',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'InternshipCRM' },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: 'any' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#1D4ED8',
  // Shrink the layout viewport when the on-screen keyboard opens instead of
  // letting it overlay the page, so a full-height screen (the chat shell, #1006)
  // keeps its composer above the keyboard rather than behind it.
  interactiveWidget: 'resizes-content',
};

// Runs before paint to set the dark class from the saved preference or the OS,
// so there's no light flash. Mirrors the server-side cookie read below.
// `theme=system` is an explicit stored value (#2078), not the absence of one:
// it is resolved here through matchMedia, which is why SSR can leave the class
// off and this script still paints the right theme on the first frame.
const NO_FLASH = `(function(){try{var h=document.documentElement;var p=function(n,a){var m=document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]+)'));if(m)return decodeURIComponent(m[1]);var v=null;try{v=localStorage.getItem(n);}catch(e){}return v||h.getAttribute(a);};var e=p('theme','data-theme-pref');var d;if(e==='dark')d=true;else if(e==='light')d=false;else d=!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);h.classList.toggle('dark',d);var fe=p('fontSize','data-font-size-pref');if(fe==='sm'||fe==='lg'||fe==='xl')h.classList.add('font-'+fe);h.classList.toggle('density-compact',p('density','data-density-pref')==='compact');}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getClientDictionary(locale);
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
      data-accent={resolveAccent(accent)}
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
        <Providers locale={locale} dict={dict}>
          {/* Public demo (#966) — above everything, on every route, so a visitor
              never mistakes the demo for their own tenant. */}
          {IS_DEMO_MODE && <DemoModeBanner />}
          {children}
        </Providers>
      </body>
    </html>
  );
}
