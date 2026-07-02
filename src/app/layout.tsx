import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import './globals.css';
import { Providers } from './providers';
import { getLocale } from '@/i18n/server';
import { getDictionary } from '@/i18n/dictionaries';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const metadata: Metadata = {
  title: 'Internship CRM - Mentor-Mentee Management',
  description: 'A comprehensive CRM for managing mentor-mentee relationships and internship programs',
  applicationName: 'Internship CRM',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'InternshipCRM' },
};

export const viewport: Viewport = {
  themeColor: '#1D4ED8',
};

// Runs before paint to set the dark class from the saved preference or the OS,
// so there's no light flash. Mirrors the server-side cookie read below.
const NO_FLASH = `(function(){try{var m=document.cookie.match(/(?:^|; )theme=([^;]+)/);var e=m?decodeURIComponent(m[1]):localStorage.getItem('theme');var h=document.documentElement;if(e==='dark')h.classList.add('dark');else if(e==='light')h.classList.remove('dark');else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)h.classList.add('dark');}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getDictionary(locale);
  let theme = (await cookies()).get('theme')?.value;
  // No device cookie yet? Fall back to the signed-in user's saved theme so it
  // follows them across devices (the no-flash script still handles OS default).
  if (!theme) {
    try {
      const session = await getServerSession(authOptions);
      if (session?.user?.id) {
        const u = await prisma.user.findUnique({ where: { id: session.user.id }, select: { theme: true } });
        if (u?.theme) theme = u.theme;
      }
    } catch { /* ignore */ }
  }

  return (
    <html lang={locale} className={theme === 'dark' ? 'dark' : undefined} suppressHydrationWarning>
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
