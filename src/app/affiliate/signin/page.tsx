import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { affiliateOrgForRequest, landingCopy } from '@/lib/affiliateProgram';

// The programme's public page on the organisation's own host. The copy is that
// organisation's data (AffiliateProgramSettings), so the same page serves any org.
export default async function AffiliateSignInPage() {
  const org = await affiliateOrgForRequest();
  if (!org) notFound();
  const settings = await prisma.affiliateProgramSettings.findUnique({
    where: { orgId: org.id },
    select: { landing: true },
  });
  if (!settings) notFound();

  const { locale, t } = await getServerDictionary();
  const copy = landingCopy(settings.landing, locale);
  if (!copy) notFound();

  return (
    <main className="mx-auto max-w-xl space-y-6 p-6">
      <h1 className="text-3xl font-semibold">{copy.title}</h1>
      <p className="whitespace-pre-line">{copy.body}</p>
      <Link href="/auth/signin?callbackUrl=/affiliate" className="inline-block rounded bg-black px-4 py-2 text-white">
        {t.affiliates.signInButton}
      </Link>
    </main>
  );
}
