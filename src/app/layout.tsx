import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
import { getLocale } from '@/i18n/server';
import { getDictionary } from '@/i18n/dictionaries';

export const metadata: Metadata = {
  title: 'Internship CRM - Mentor-Mentee Management',
  description: 'A comprehensive CRM for managing mentor-mentee relationships and internship programs',
  applicationName: 'Internship CRM',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'InternshipCRM' },
};

export const viewport: Viewport = {
  themeColor: '#1D4ED8',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getDictionary(locale);
  return (
    <html lang={locale}>
      <body>
        <Providers locale={locale} dict={dict}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
