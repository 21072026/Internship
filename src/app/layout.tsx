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
import { DEFAULT_ACCENT, resolveAccent } from '@/lib/accent';
import { IS_DEMO_MODE } from '@/lib/demoMode';
import { IS_PREVIEW } from '@/lib/appEnv';
import { PRODUCT } from '@/lib/product';
import { DemoModeBanner } from '@/components/DemoModeBanner';

// A function rather than a constant because the title/name depend on which
// product this container serves (src/lib/product.ts), and APP_PRODUCT is read at
// run time — a module-level constant would be evaluated once at build and bake
// one product's name into the shared image.
export function generateMetadata(): Metadata {
  return {
    title: PRODUCT.title,
    description: PRODUCT.description,
    applicationName: PRODUCT.name,
    appleWebApp: { capable: true, statusBarStyle: 'default', title: PRODUCT.shortName },
    icons: {
      icon: [
        { url: '/icon.svg', type: 'image/svg+xml' },
        { url: '/favicon.ico', sizes: 'any' },
      ],
      apple: '/apple-touch-icon.png',
    },
  };
}

export function generateViewport(): Viewport {
  return {
    themeColor: PRODUCT.themeColor,
    // Shrink the layout viewport when the on-screen keyboard opens instead of
    // letting it overlay the page, so a full-height screen (the chat shell, #1006)
    // keeps its composer above the keyboard rather than behind it.
    interactiveWidget: 'resizes-content',
  };
}

// Runs before paint to set the dark class from the saved preference or the OS,
// so there's no light flash. Mirrors the server-side cookie read below.
const NO_FLASH = `(function(){try{var m=document.cookie.match(/(?:^|; )theme=([^;]+)/);var e=m?decodeURIComponent(m[1]):localStorage.getItem('theme');var h=document.documentElement;if(e==='dark')h.classList.add('dark');else if(e==='light')h.classList.remove('dark');else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)h.classList.add('dark');var fm=document.cookie.match(/(?:^|; )fontSize=([^;]+)/);var fe=fm?decodeURIComponent(fm[1]):localStorage.getItem('fontSize');if(fe==='sm'||fe==='lg'||fe==='xl')h.classList.add('font-'+fe);}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getClientDictionary(locale);
  const cookieStore = await cookies();
  let theme = cookieStore.get('theme')?.value;
  let fontSize = cookieStore.get('fontSize')?.value;
  let accent = cookieStore.get('accent')?.value;
  // No device cookie yet? Fall back to the signed-in user's saved preferences
  // so they follow them across devices (the no-flash script still handles OS default).
  // Signed-out visitors have none, and this layout wraps every page — so gate on
  // the session cookie rather than paying a session decode per view (#1197).
  if ((!theme || !fontSize || !accent) && (await hasSessionCookie())) {
    try {
      const session = await getServerSession(authOptions);
      if (session?.user?.id) {
        const u = await prisma.user.findUnique({ where: { id: session.user.id }, select: { theme: true, fontSize: true, accentColor: true } });
        if (!theme && u?.theme) theme = u.theme;
        if (!fontSize && u?.fontSize) fontSize = u.fontSize;
        if (!accent && u?.accentColor) accent = u.accentColor;
      }
    } catch { /* ignore */ }
  }
  // With no stored preference the accent comes from the product this container
  // serves — EXCEPT on preview, whose green is a "this is not production" signal
  // and outranks the product's own colour (mistaking preview for prod is worse
  // than mistaking one product for the other).
  const accentFallback = IS_PREVIEW ? DEFAULT_ACCENT : PRODUCT.accent;
  const fontSizeClass = fontSize === 'sm' || fontSize === 'lg' || fontSize === 'xl' ? `font-${fontSize}` : undefined;

  return (
    <html
      lang={locale}
      className={[theme === 'dark' ? 'dark' : undefined, fontSizeClass].filter(Boolean).join(' ') || undefined}
      data-accent={resolveAccent(accent, accentFallback)}
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
