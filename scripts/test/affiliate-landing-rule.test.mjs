// Unit tests for the public partner-programme page's content
// (src/lib/affiliateLandingRule.ts, docs/affiliate-module.md, #3359).
// Synthetic copy and example hosts only.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLanding,
  readStoredLanding,
  canonicalLanding,
  landingCopyFor,
  landingHasContent,
  parsePhone,
  telHref,
  parseEmail,
  EMPTY_LANDING,
  LANDING_LIMITS,
  statCards,
  needsLiveStats,
  STAT_LIVE_MIN_PARTNERS,
} from '../../src/lib/affiliateLandingRule.ts';

const fields = (r) => (r.ok ? [] : r.issues.map((i) => `${i.field}:${i.code}`));

test('an empty object is a valid, empty landing', () => {
  assert.deepEqual(parseLanding({}), { ok: true, landing: EMPTY_LANDING });
  assert.equal(landingHasContent(EMPTY_LANDING), false);
});

test('copy is trimmed, single-line fields collapse whitespace, paragraphs keep line breaks', () => {
  const r = parseLanding({
    copy: { de: { heroTitle: '  Partner   werden ', intro: 'Zeile eins\r\nZeile zwei  ', applyLabel: '' } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.landing.copy.de, { heroTitle: 'Partner werden', intro: 'Zeile eins\nZeile zwei' });
  assert.equal(landingHasContent(r.landing), true);
});

test('steps and bullets drop empty rows and keep half-filled ones', () => {
  const r = parseLanding({
    copy: {
      en: {
        steps: [{ title: 'Sign up', text: 'In seconds.' }, { title: '', text: '' }, { title: 'Share' }],
        bullets: ['No auto-renewal', '  ', 'Cancel any time'],
      },
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.landing.copy.en.steps, [
    { title: 'Sign up', text: 'In seconds.' },
    { title: 'Share', text: '' },
  ]);
  assert.deepEqual(r.landing.copy.en.bullets, ['No auto-renewal', 'Cancel any time']);
});

test('every problem is named by its path', () => {
  const r = parseLanding({
    copy: {
      fr: { heroTitle: 'x' },
      de: {
        heroTitle: 'x'.repeat(LANDING_LIMITS.text + 1),
        intro: 42,
        nope: 'x',
        steps: Array.from({ length: LANDING_LIMITS.steps + 1 }, () => ({ title: 'a', text: 'b' })),
        bullets: 'not a list',
      },
    },
    phone: 'call me',
    email: 'not-an-address',
    productSignupUrl: 'http://app.example/signup',
    extra: true,
  });
  assert.deepEqual(fields(r).sort(), [
    'copy.de.bullets:type',
    'copy.de.heroTitle:too_long',
    'copy.de.intro:type',
    'copy.de.nope:unknown',
    'copy.de.steps:too_many',
    'copy.fr:locale',
    'email:invalid',
    'extra:unknown',
    'phone:invalid',
    'productSignupUrl:not_https',
  ]);
});

test('non-objects are refused as a whole', () => {
  for (const v of [null, 'x', [], 1]) assert.deepEqual(fields(parseLanding(v)), ['*:type']);
});

test('phone numbers: what a person types, and the tel: link', () => {
  assert.equal(parsePhone(' +49 (0) 30  123-456 '), '+49 (0) 30 123-456');
  assert.equal(parsePhone('030/123.45'), '030/123.45');
  assert.equal(parsePhone('1234'), null); // too few digits
  assert.equal(parsePhone('12+345678'), null); // + only at the start
  assert.equal(parsePhone('0800 CALL NOW'), null);
  assert.equal(telHref('+49 (0) 30 123-456'), 'tel:+49030123456');
  assert.equal(telHref('030/123.45'), 'tel:03012345');
});

test('e-mail addresses: simple shape only', () => {
  assert.equal(parseEmail(' hello@partner.example '), 'hello@partner.example');
  assert.equal(parseEmail('a@b'), null);
  assert.equal(parseEmail('two words@partner.example'), null);
  assert.equal(parseEmail('<x>@partner.example'), null);
});

test('the sign-up URL is https without credentials, stored as printed', () => {
  const ok = parseLanding({ productSignupUrl: ' https://app.example/register ' });
  assert.equal(ok.landing.productSignupUrl, 'https://app.example/register');
  assert.deepEqual(fields(parseLanding({ productSignupUrl: 'https://u:p@app.example/' })), ['productSignupUrl:invalid']);
  assert.deepEqual(fields(parseLanding({ productSignupUrl: 'javascript:alert(1)' })), ['productSignupUrl:not_https']);
  assert.deepEqual(fields(parseLanding({ productSignupUrl: 'nope' })), ['productSignupUrl:invalid']);
});

test('a malformed stored value reads as empty, never throws', () => {
  assert.deepEqual(readStoredLanding(null), EMPTY_LANDING);
  assert.deepEqual(readStoredLanding({ copy: 'x' }), EMPTY_LANDING);
  assert.deepEqual(readStoredLanding({ copy: { en: { heroTitle: 'Hi' } } }).copy.en, { heroTitle: 'Hi' });
});

test('the canonical form ignores key order', () => {
  const a = parseLanding({ copy: { de: { intro: 'b', heroTitle: 'a' }, en: { heroTitle: 'c' } }, email: 'x@y.example' }).landing;
  const b = parseLanding({ email: 'x@y.example', copy: { en: { heroTitle: 'c' }, de: { heroTitle: 'a', intro: 'b' } } }).landing;
  assert.equal(canonicalLanding(a), canonicalLanding(b));
  const c = parseLanding({ copy: { de: { heroTitle: 'a', intro: 'B' }, en: { heroTitle: 'c' } }, email: 'x@y.example' }).landing;
  assert.notEqual(canonicalLanding(a), canonicalLanding(c));
});

test('a visitor reads their locale field by field, then English, then the rest', () => {
  const landing = parseLanding({
    copy: {
      en: { heroTitle: 'Become a partner', intro: 'English intro', steps: [{ title: 'One', text: '' }] },
      de: { heroTitle: 'Partner werden', bullets: ['Jederzeit kündbar'] },
      tr: { ctaTitle: 'Hemen başla' },
    },
  }).landing;
  const de = landingCopyFor(landing, 'de');
  assert.equal(de.heroTitle, 'Partner werden');
  assert.equal(de.intro, 'English intro');
  assert.equal(de.ctaTitle, 'Hemen başla');
  assert.deepEqual(de.steps, [{ title: 'One', text: '' }]);
  assert.deepEqual(de.bullets, ['Jederzeit kündbar']);
  assert.equal(landingCopyFor(landing, 'xx').heroTitle, 'Become a partner');
  assert.deepEqual(landingCopyFor(EMPTY_LANDING, 'de'), {});
});

test('the public table follows the plan: sorted bands, then the open top band', async () => {
  const { commissionTableRows, maxOneOffCommission } = await import('../../src/lib/affiliateLandingRule.ts');
  const plan = {
    currency: 'EUR',
    tiers: [
      { upToMinor: 5_000, commissionMinor: 1_000 },
      { upToMinor: 2_000, commissionMinor: 500 },
    ],
    topCommissionMinor: 1_500,
    percentBps: 0,
    switchAtCustomer: null,
    windowMonths: null,
  };
  assert.deepEqual(commissionTableRows(plan), [
    { overMinor: null, upToMinor: 2_000, commissionMinor: 500 },
    { overMinor: 2_000, upToMinor: 5_000, commissionMinor: 1_000 },
    { overMinor: 5_000, upToMinor: null, commissionMinor: 1_500 },
  ]);
  assert.equal(maxOneOffCommission(plan), 1_500);
  assert.deepEqual(commissionTableRows({ ...plan, tiers: [] }), [{ overMinor: null, upToMinor: null, commissionMinor: 1_500 }]);
});

// ── The figure cards (#3364) ──────────────────────────────────────────────

test('stat cards: live, manual and hidden parse; satisfaction cannot be live; a manual card needs a short figure', () => {
  const ok = parseLanding({ stats: { activePartners: { mode: 'live' }, customers: { mode: 'hidden' }, satisfaction: { mode: 'manual', value: '  98 % ' } } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.landing.stats, {
    activePartners: { mode: 'live', value: null },
    customers: { mode: 'hidden', value: null },
    satisfaction: { mode: 'manual', value: '98 %' },
  });

  const bad = parseLanding({
    stats: {
      satisfaction: { mode: 'live' },
      activePartners: { mode: 'manual', value: '' },
      customers: { mode: 'manual', value: 'x'.repeat(LANDING_LIMITS.statValue + 1) },
      ranking: { mode: 'hidden' },
    },
  });
  assert.deepEqual(fields(bad).sort(), ['stats.activePartners.value:invalid', 'stats.customers.value:too_long', 'stats.ranking:unknown', 'stats.satisfaction.mode:invalid'].sort());
  assert.deepEqual(fields(parseLanding({ stats: { customers: { mode: 'sometimes' } } })), ['stats.customers.mode:invalid']);
  assert.deepEqual(fields(parseLanding({ stats: 'live' })), ['stats:type']);
});

test('stat cards: what a visitor sees — fixed order, typed figures as typed, live counts only above the threshold', () => {
  const landing = parseLanding({
    stats: { satisfaction: { mode: 'manual', value: '98 %' }, customers: { mode: 'live' }, activePartners: { mode: 'live' } },
  }).landing;
  const big = { activePartners: STAT_LIVE_MIN_PARTNERS, customers: 1234 };
  assert.deepEqual(statCards(landing, big, (n) => n.toLocaleString('de-DE')), [
    { key: 'activePartners', value: String(STAT_LIVE_MIN_PARTNERS) },
    { key: 'customers', value: '1.234' },
    { key: 'satisfaction', value: '98 %' },
  ]);
  // Below the threshold — and when the counts could not be read — every live card is gone.
  assert.deepEqual(statCards(landing, { activePartners: STAT_LIVE_MIN_PARTNERS - 1, customers: 5000 }), [{ key: 'satisfaction', value: '98 %' }]);
  assert.deepEqual(statCards(landing, null), [{ key: 'satisfaction', value: '98 %' }]);
  // Nothing configured shows nothing, and asks for no counts.
  assert.deepEqual(statCards(EMPTY_LANDING, big), []);
  assert.equal(needsLiveStats(EMPTY_LANDING), false);
  assert.equal(needsLiveStats(landing), true);
});

test('stat cards take part in the change comparison; a hidden card equals an absent one', () => {
  const a = parseLanding({ stats: { satisfaction: { mode: 'manual', value: '98 %' } } }).landing;
  const b = parseLanding({ stats: { satisfaction: { mode: 'manual', value: '97 %' } } }).landing;
  const hidden = parseLanding({ stats: { customers: { mode: 'hidden' } } }).landing;
  assert.notEqual(canonicalLanding(a), canonicalLanding(b));
  assert.equal(canonicalLanding(hidden), canonicalLanding(EMPTY_LANDING));
  // A stored landing from before #3364 (no `stats`) still reads.
  assert.deepEqual(readStoredLanding({ copy: { en: { heroTitle: 'Partners' } } }).stats, {});
});

test('the live figures are read once per organisation per window, refreshed after it, and a failed read shows nothing', async () => {
  const { makeTtlCache } = await import('../../src/lib/affiliatePublicStatsCache.ts');
  const cache = makeTtlCache(1000);
  let reads = 0;
  let partners = 12;
  const load = async () => {
    reads += 1;
    return { activePartners: partners, customers: 3 };
  };
  assert.deepEqual(await cache.get('org-a', load, 0), { activePartners: 12, customers: 3 });
  partners = 15;
  assert.equal((await cache.get('org-a', load, 999)).activePartners, 12); // still inside the window
  assert.equal(reads, 1);
  assert.equal((await cache.get('org-a', load, 1000)).activePartners, 15); // the window passed
  assert.equal(reads, 2);
  assert.equal((await cache.get('org-b', load, 1000)).activePartners, 15); // per organisation
  assert.equal(await cache.get('org-c', async () => { throw new Error('db down'); }, 0), null);
});

test('a partner link sends the visitor to the sign-up page with that code only', async () => {
  const { customerSignupRedirect, REFERRAL_CODE_RE } = await import('../../src/lib/affiliateLandingRule.ts');
  const signup = 'https://app.acme.example/register';
  assert.equal(customerSignupRedirect(signup, 'demo-partner'), 'https://app.acme.example/register?ref=demo-partner');
  assert.equal(customerSignupRedirect('https://app.acme.example/register?lang=de&ref=old', 'K_1'), 'https://app.acme.example/register?lang=de&ref=K_1');
  for (const bad of ['', 'https://evil.example', '-x', 'a b', 'x'.repeat(101), ['a'], undefined]) {
    assert.equal(customerSignupRedirect(signup, bad), null, String(bad));
  }
  assert.equal(customerSignupRedirect(null, 'demo-partner'), null);
  assert.equal(customerSignupRedirect('http://app.acme.example/', 'demo-partner'), null);
  // The same shape as the partner code (src/lib/affiliatePartners.ts imports Prisma, so it is read as text).
  const { readFileSync } = await import('node:fs');
  const partners = readFileSync(new URL('../../src/lib/affiliatePartners.ts', import.meta.url), 'utf8');
  assert.ok(partners.includes(`PARTNER_CODE_RE = /${REFERRAL_CODE_RE.source}/;`), 'REFERRAL_CODE_RE must match PARTNER_CODE_RE');
});

// ── The page's look (#3535) ──────────────────────────────────────────────────
import {
  DEFAULT_THEME,
  FONT_KEYS,
  THEME_OPTIONS,
  contrastRatio,
  onFill,
  parseHexColor,
  themePalette,
  themeMediaRefs,
  changedLandingFields,
  themeMediaKind,
  themeMediaUrl,
} from '../../src/lib/affiliateLandingRule.ts';

const ID = 'clx0example0asset0id0001';

test('no theme stays no theme: the page renders as it always did', () => {
  assert.equal(parseLanding({}).landing.theme, null);
  assert.equal(parseLanding({ theme: null }).landing.theme, null);
  assert.equal(readStoredLanding({ copy: { en: { heroTitle: 'x' } } }).theme, null);
});

test('a partial theme is filled from the defaults, colours are normalised', () => {
  const r = parseLanding({ theme: { colors: { primary: '#1D4ED8', heading: '#000' }, headingFont: 'poppins', animation: 'rise' } });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.landing.theme.colors.primary, '#1d4ed8');
  assert.equal(r.landing.theme.colors.heading, '#000000');
  assert.equal(r.landing.theme.colors.background, DEFAULT_THEME.colors.background);
  assert.equal(r.landing.theme.headingFont, 'poppins');
  assert.equal(r.landing.theme.bodyFont, 'inter');
  assert.equal(r.landing.theme.animation, 'rise');
  assert.equal(r.landing.theme.heroHeight, 'compact');
});

test('the default theme is AA-clean', () => {
  assert.equal(parseLanding({ theme: DEFAULT_THEME }).ok, true);
});

test('only #rrggbb colours: names, functions, variables and CSS are refused', () => {
  for (const bad of ['red', 'rgb(0,0,0)', 'var(--x)', '#12345', '#1234567', 'url(https://x.example/a.png)', '#fff;background:url(x)', 42]) {
    assert.equal(parseHexColor(bad), null, String(bad));
    const r = parseLanding({ theme: { colors: { primary: bad } } });
    assert.deepEqual(fields(r), ['theme.colors.primary:invalid'], String(bad));
  }
});

test('fonts and options come from fixed lists; unknown keys are refused', () => {
  assert.ok(FONT_KEYS.includes('manrope'));
  const r = parseLanding({
    theme: {
      headingFont: 'Comic Sans',
      bodyFont: 'https://fonts.example/x.css',
      heroHeight: 'giant',
      animation: 'spin',
      css: 'body{display:none}',
      script: 'alert(1)',
      colors: { link: '#000000' },
    },
  });
  assert.deepEqual(fields(r).sort(), [
    'theme.animation:invalid',
    'theme.bodyFont:invalid',
    'theme.colors.link:unknown',
    'theme.css:unknown',
    'theme.headingFont:invalid',
    'theme.heroHeight:invalid',
    'theme.script:unknown',
  ]);
  for (const [key, values] of Object.entries(THEME_OPTIONS)) {
    for (const v of values) assert.equal(parseLanding({ theme: { [key]: v } }).ok, true, `${key}=${v}`);
  }
});

test('media are asset ids of our own storage, never an address', () => {
  assert.equal(parseLanding({ theme: { media: { logo: ID, hero: null, showcase: '' } } }).ok, true);
  for (const bad of ['https://cdn.example/logo.png', '//cdn.example/x.png', 'data:image/png;base64,AAAA', '/api/public/partner-media/x', '../etc', 7]) {
    assert.deepEqual(fields(parseLanding({ theme: { media: { hero: bad } } })), ['theme.media.hero:invalid'], String(bad));
  }
  assert.deepEqual(fields(parseLanding({ theme: { media: { favicon: ID } } })), ['theme.media.favicon:unknown']);
  const r = parseLanding({ theme: { media: { logo: ID, showcase: ID } } });
  assert.deepEqual(themeMediaRefs(r.landing.theme), [{ slot: 'logo', id: ID }, { slot: 'showcase', id: ID }]);
  assert.equal(themeMediaUrl(ID), `/api/public/partner-media/${ID}`);
});

test('upload types: raster images and mp4/webm only — no SVG, no GIF', () => {
  assert.equal(themeMediaKind('image/PNG'), 'image');
  assert.equal(themeMediaKind('video/webm'), 'video');
  for (const t of ['image/svg+xml', 'image/gif', 'text/html', 'video/quicktime', '']) assert.equal(themeMediaKind(t), null, t);
});

test('WCAG contrast: known ratios', () => {
  assert.equal(Math.round(contrastRatio('#ffffff', '#000000') * 10) / 10, 21);
  assert.equal(Math.round(contrastRatio('#777777', '#ffffff') * 100) / 100, 4.48);
  assert.equal(contrastRatio('#123456', '#123456'), 1);
});

test('text on a fill: white when it reaches the bar, else black', () => {
  assert.equal(onFill(['#1d4ed8'], 4.5), '#ffffff');
  assert.equal(onFill(['#facc15'], 4.5), '#000000');
  // A saturated orange: white is enough for large text (3:1), not for body text.
  assert.equal(onFill(['#ff5500'], 3), '#ffffff');
  assert.equal(onFill(['#ff5500'], 4.5), '#000000');
  // Black → yellow: no single text colour reads on both stops.
  assert.equal(onFill(['#000000', '#ffff00'], 3), null);
});

test('contrast is refused on the colour to change, and only for what is rendered', () => {
  const pale = parseLanding({ theme: { colors: { text: '#cccccc' } } });
  assert.deepEqual(fields(pale).sort(), ['theme.colors.surface:contrast', 'theme.colors.text:contrast']);
  assert.deepEqual(fields(parseLanding({ theme: { colors: { heading: '#eeeeee' } } })), ['theme.colors.heading:contrast']);
  // The primary colour itself is never refused: text on it is derived, and accents fall back to the heading colour.
  assert.equal(parseLanding({ theme: { colors: { primary: '#f3f3f3', secondary: '#e5e7eb' } } }).ok, true);
  // A gradient no text can sit on: refused for the gradient hero and the band…
  const clash = { colors: { primary: '#000000', secondary: '#ffff00' }, ctaStyle: 'plain' };
  assert.deepEqual(fields(parseLanding({ theme: clash })), ['theme.colors.secondary:contrast']);
  // …but asked of nobody when the hero is a picture and the call to action is plain.
  assert.equal(parseLanding({ theme: { ...clash, media: { hero: ID } } }).ok, true);
  // A light orange → amber gradient carries large text, not body text: fine as a plain CTA, refused as a band.
  const warm = { colors: { primary: '#ff5500', secondary: '#ff7a00', surface: '#ffffff' } };
  assert.equal(parseLanding({ theme: { ...warm, ctaStyle: 'plain' } }).ok, true);
  assert.equal(parseLanding({ theme: { ...warm, ctaStyle: 'band' } }).ok, true, 'black text reaches 4.5:1 on both');
});

test('the palette derives every text colour on a fill', () => {
  const colors = { primary: '#ff5500', secondary: '#6d28d9', heading: '#0b1f4d', background: '#ffffff', surface: '#f3f5f8', text: '#4b4c50' };
  // Orange → violet: white reads as large text on both stops (the hero), not as body text (a band).
  assert.deepEqual(fields(parseLanding({ theme: { colors, ctaStyle: 'band' } })), ['theme.colors.secondary:contrast']);
  const r = parseLanding({ theme: { colors, ctaStyle: 'plain' } });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  const p = themePalette(r.landing.theme);
  assert.equal(p.onPrimary, '#ffffff');
  assert.equal(p.onSecondary, '#ffffff');
  assert.equal(p.onHeading, '#ffffff');
  // Orange on white is below 4.5:1, so the small eyebrow text takes the heading colour.
  assert.equal(p.accentText, '#0b1f4d');
  // …and below 3:1 on the grey cards, so the figures do too.
  assert.equal(p.accentLarge, '#0b1f4d');
});

test('an unchanged theme in another key order is not a change; the audit names fields only', () => {
  const a = parseLanding({ copy: { en: { heroTitle: 'A' } }, theme: { colors: { primary: '#1d4ed8' }, animation: 'fade' } }).landing;
  const b = parseLanding({ theme: { animation: 'fade', colors: { primary: '#1D4ED8' } }, copy: { en: { heroTitle: 'A' } } }).landing;
  assert.equal(canonicalLanding(a), canonicalLanding(b));
  assert.deepEqual(changedLandingFields(a, b), []);
  assert.notEqual(canonicalLanding(a), canonicalLanding({ ...a, theme: null }));
  assert.deepEqual(changedLandingFields(a, { ...a, theme: null }), ['theme']);
  const c = parseLanding({
    copy: { en: { heroTitle: 'A' }, de: { heroTitle: 'B' } },
    phone: '+49 30 1234567',
    theme: { colors: { primary: '#1e40af' }, animation: 'none', headingFont: 'lato', corners: 'square', media: { logo: ID } },
  }).landing;
  assert.deepEqual(changedLandingFields(a, c), ['copy.de', 'phone', 'theme.colors', 'theme.fonts', 'theme.layout', 'theme.animation', 'theme.media']);
  for (const f of changedLandingFields(a, c)) assert.doesNotMatch(f, /#|B|1234/);
});
