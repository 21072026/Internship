import { getServerSession } from 'next-auth';
import { notFound, redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { NO_INDEX } from '@/lib/pageMetadata';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { getServerDictionary } from '@/i18n/server';
import { operatorIdentity } from '@/lib/imprint';
import { originForWorld } from '@/lib/hostWorld';
import { worldOfOrg } from '@/lib/userWorld';
import { findCampaign } from '@/lib/postCampaign';
import { campaignShortLink, renderLetter } from '@/lib/postCampaignRule';
import { art14Notice } from '@/lib/postCampaignTemplates';
import { WeeklyReportPrintButton } from '@/components/WeeklyReportPrintButton';

export const metadata = NO_INDEX;

// The letters of a postal campaign, ready to print (#2697): one A4 sheet per
// recipient, DIN 5008 form B — the address sits in the window of a DL envelope
// — with the Art. 14 DSGVO notice on the back (print duplex). Outside /admin on
// purpose: the admin shell's sidebar and padding have no place on a letter.
//
// The sender is the identity this deployment publishes for the campaign's OWN
// world (MARKETING_OPERATOR_* for SaleVali, src/lib/imprint.ts), never the
// host the admin happens to be on; the link is that world's origin.

const MM = (n: number) => `${n}mm`;

export default async function PrintPostCampaign({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  if (session.user.role !== 'ADMIN') notFound();
  if (!(await shellCapabilities(session.user.orgId)).includes('companies')) notFound();
  const { id } = await params;

  const data = await withTenantScope(session, async () => {
    const campaign = await findCampaign(await tenantWhere(session), id);
    if (!campaign) return null;
    const recipients = await prisma.postCampaignRecipient.findMany({
      where: { campaignId: campaign.id, orgId: campaign.orgId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, recipientName: true, addressBlock: true, company: { select: { name: true } } },
    });
    return { campaign, recipients };
  });
  if (!data) notFound();
  const { campaign, recipients } = data;

  const world = await worldOfOrg(campaign.orgId);
  const operator = operatorIdentity(process.env, world);
  const link = campaignShortLink(originForWorld(world), campaign.code);
  const linkLabel = link.replace(/^https?:\/\//, '');
  const qr = await QRCode.toString(link, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  const notice = art14Notice({ operator, dataSource: campaign.dataSource });
  const today = new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeZone: 'Europe/Berlin' }).format(campaign.sentAt ?? new Date());
  const { t } = await getServerDictionary();
  const returnLine = operator ? [operator.name, ...operator.address].join(' · ') : '';
  const footer = operator
    ? [operator.name, operator.register, operator.vatId ? `USt-IdNr. ${operator.vatId}` : null, `Impressum: ${originForWorld(world).replace(/^https?:\/\//, '')}/imprint`]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <div data-testid="post-campaign-print">
      <style>{`
        @page { size: A4; margin: 0; }
        @media print { body { background: #fff !important; } .sheet { box-shadow: none !important; margin: 0 !important; } }
        .sheet { width: 210mm; height: 297mm; position: relative; overflow: hidden; background: #fff; color: #111;
                 margin: 0 auto 12mm; box-shadow: 0 1px 6px rgba(0,0,0,.15); break-after: page; page-break-after: always;
                 font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.4; }
        .mark { position: absolute; left: 0; width: 6mm; border-top: 0.3pt solid #999; }
      `}</style>
      <div className="no-print mx-auto my-6 flex max-w-[210mm] items-center justify-between gap-4 px-2">
        <p className="text-sm text-gray-600">
          {campaign.name} · {t.postCampaigns.recipientsTitle.replace('{n}', String(recipients.length))}
        </p>
        <WeeklyReportPrintButton label={t.postCampaigns.print} />
      </div>

      {recipients.map((r) => (
        <div key={r.id}>
          <section className="sheet" data-testid={`post-letter-${r.id}`}>
            {/* Fold marks (form B) and the hole mark. */}
            <span className="mark" style={{ top: MM(105) }} />
            <span className="mark" style={{ top: MM(148.5), width: MM(4) }} />
            <span className="mark" style={{ top: MM(210) }} />

            {/* Sender, top right. */}
            <div style={{ position: 'absolute', top: MM(15), right: MM(20), textAlign: 'right', fontSize: '9pt' }}>
              {operator && (
                <>
                  <strong style={{ fontSize: '11pt' }}>{operator.name}</strong>
                  {operator.address.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                  <div>{operator.email}</div>
                  {operator.phone && <div>{operator.phone}</div>}
                </>
              )}
            </div>

            {/* Address field: 20 mm from the left, 45 mm from the top, 85 × 45 mm. */}
            <div style={{ position: 'absolute', left: MM(20), top: MM(45), width: MM(85), height: MM(45) }}>
              <div style={{ fontSize: '7pt', borderBottom: '0.3pt solid #999', marginBottom: MM(3), whiteSpace: 'nowrap', overflow: 'hidden' }}>
                {returnLine}
              </div>
              {r.addressBlock.split('\n').map((line, i) => (
                <div key={i} data-testid="post-letter-address-line">{line}</div>
              ))}
            </div>

            {/* Date, right, level with the address field. */}
            <div style={{ position: 'absolute', top: MM(80), right: MM(20) }}>{today}</div>

            {/* Body: starts below the address field (form B, ~98 mm). */}
            <div style={{ position: 'absolute', top: MM(98), left: MM(25), right: MM(20), bottom: MM(30), whiteSpace: 'pre-line' }} data-testid="post-letter-body">
              {renderLetter(campaign.letterBody, { company: r.company.name, contactName: r.recipientName, link: linkLabel })}
            </div>

            {/* QR to the same link, bottom right above the footer. */}
            <div style={{ position: 'absolute', right: MM(20), bottom: MM(30), width: MM(22), height: MM(22) }} dangerouslySetInnerHTML={{ __html: qr }} />

            <div style={{ position: 'absolute', left: MM(25), right: MM(20), bottom: MM(12), fontSize: '7.5pt', color: '#555', borderTop: '0.3pt solid #ccc', paddingTop: MM(2) }}>
              {footer} · Datenschutzhinweise: Rückseite
            </div>
          </section>

          {/* The back: Art. 14 notice. */}
          <section className="sheet" style={{ padding: `${MM(20)} ${MM(20)} ${MM(15)} ${MM(25)}`, fontSize: '9pt' }} data-testid={`post-notice-${r.id}`}>
            <h2 style={{ fontSize: '11pt', fontWeight: 700, marginBottom: MM(4) }}>{notice.title}</h2>
            {notice.paragraphs.map(([title, text]) => (
              <p key={title} style={{ marginBottom: MM(3) }}>
                <strong>{title}: </strong>
                {text}
              </p>
            ))}
          </section>
        </div>
      ))}
    </div>
  );
}
