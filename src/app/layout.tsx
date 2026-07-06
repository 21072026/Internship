import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import './globals.css';
import { Providers } from './providers';
import { getLocale } from '@/i18n/server';
import { getDictionary } from '@/i18n/dictionaries';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { resolveAccent } from '@/lib/accent';

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
};

// Runs before paint to set the dark class from the saved preference or the OS,
// so there's no light flash. Mirrors the server-side cookie read below.
const NO_FLASH = `(function(){try{var m=document.cookie.match(/(?:^|; )theme=([^;]+)/);var e=m?decodeURIComponent(m[1]):localStorage.getItem('theme');var h=document.documentElement;if(e==='dark')h.classList.add('dark');else if(e==='light')h.classList.remove('dark');else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)h.classList.add('dark');var fm=document.cookie.match(/(?:^|; )fontSize=([^;]+)/);var fe=fm?decodeURIComponent(fm[1]):localStorage.getItem('fontSize');if(fe==='sm'||fe==='lg'||fe==='xl')h.classList.add('font-'+fe);}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getDictionary(locale);
  const cookieStore = await cookies();
  let theme = cookieStore.get('theme')?.value;
  let fontSize = cookieStore.get('fontSize')?.value;
  let accent = cookieStore.get('accent')?.value;
  // No device cookie yet? Fall back to the signed-in user's saved preferences
  // so they follow them across devices (the no-flash script still handles OS default).
  if (!theme || !fontSize || !accent) {
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
  const fontSizeClass = fontSize === 'sm' || fontSize === 'lg' || fontSize === 'xl' ? `font-${fontSize}` : undefined;

  return (
    <html
      lang={locale}
      className={[theme === 'dark' ? 'dark' : undefined, fontSizeClass].filter(Boolean).join(' ') || undefined}
      data-accent={resolveAccent(accent)}
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
          {children}
        </Providers>
      </body>
    </html>
  );
}
