import { ImageResponse } from 'next/og';
import { getServerDictionary, resolveRequestVertical } from '@/i18n/server';
import type { Dictionary } from '@/i18n/dictionaries';
import { themeColorFor } from '@/lib/accent';
import { brandAssetDataUri, hostBrand, requestProductName } from '@/lib/hostBrand';

// The share cards (#1378): what a link to a public page shows on LinkedIn,
// WhatsApp, Slack or X. One renderer for every page, modelled on the profile
// card (src/app/p/[userId]/opengraph-image.tsx): 1200×630, rendered by next/og
// on the server — no external fetch, so the CSP never sees it — and in the
// request's vertical, so a marketing host's card names its own product in its
// colour.
//
// What a card may carry is the page's own public copy and nothing else: no
// live number (it would freeze into the image, landing honesty rule §4.3) and
// no PII. A scraper sends no locale cookie, so in practice it reads the
// default locale; a signed-in preview reads the viewer's.

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';

export type CardCopy = { title: string; subtitle?: string; chips?: string[] };

// satori has no line clamping; cut in JS so a long subtitle cannot overflow.
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Render one card. `copy` null → the generic brand card (no page content). */
export async function renderCard(copy: CardCopy | null): Promise<ImageResponse> {
  const vertical = await resolveRequestVertical();
  let brand = themeColorFor(vertical);
  let productName = await requestProductName(vertical);
  // A card is fetched by a scraper, without cookies: a host mapped to an
  // organization with brand data (#2922) gets that organization's name and
  // colour, and its mark — read from the database as a data: URI, never
  // fetched over the network — on its own tile instead of the initial. A
  // default brand keeps the card above.
  let mark: { src: string; tile: string } | null = null;
  const host = await hostBrand();
  if (host.source === 'org') {
    brand = host.themeColor;
    productName = host.productName;
    const src = await brandAssetDataUri(host.markVersion, 'mark-128');
    if (src) mark = { src, tile: host.tileColor };
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: OG_SIZE.width,
          height: OG_SIZE.height,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#ffffff',
          borderTop: `16px solid ${brand}`,
          padding: 72,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: mark ? mark.tile : brand,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff',
              fontSize: 28,
              fontWeight: 700,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- satori renders a plain <img> from a data: URI */}
            {mark ? <img src={mark.src} width={34} height={34} alt="" /> : productName.slice(0, 1)}
          </div>
          <div style={{ color: brand, fontSize: 30, fontWeight: 700 }}>{productName}</div>
        </div>

        {copy ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ color: '#111827', fontSize: 64, fontWeight: 800, lineHeight: 1.1 }}>
              {clip(copy.title, 70)}
            </div>
            {copy.subtitle && (
              <div style={{ color: '#374151', fontSize: 30, lineHeight: 1.35 }}>{clip(copy.subtitle, 150)}</div>
            )}
            {copy.chips && copy.chips.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {copy.chips.slice(0, 6).map((chip) => (
                  <div
                    key={chip}
                    style={{
                      display: 'flex',
                      border: `2px solid ${brand}`,
                      color: brand,
                      borderRadius: 999,
                      padding: '6px 18px',
                      fontSize: 22,
                      fontWeight: 600,
                    }}
                  >
                    {clip(chip, 30)}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex' }} />
        )}

        <div style={{ display: 'flex', height: 8, width: 160, background: brand, borderRadius: 4 }} />
      </div>
    ),
    OG_SIZE
  );
}

/** A public page's card, from the same dictionary keys as its title. */
export async function pageCard(pick: (t: Dictionary) => CardCopy): Promise<ImageResponse> {
  const { t } = await getServerDictionary();
  return renderCard(pick(t));
}
