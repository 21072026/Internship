#!/usr/bin/env node
// Reproducible channel exports (#2225). Run after capture:landing -- --channels.
// Native SVG/logo rasterization, never a fabricated product screenshot.
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = new URL(process.env.BASE_URL || 'http://localhost:3000');
if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('OG validation requires a local server');
const output = path.resolve(process.env.CHANNEL_OUTPUT_DIR || '/tmp/interncrm-channel-assets');
const assets = path.join(root, 'public/marketing');
mkdirSync(output, { recursive: true });
mkdirSync(assets, { recursive: true });
const copy = readFileSync(path.join(root, 'docs/marketing/copy-bank.md'), 'utf8');
const esc = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const icon = readFileSync(path.join(root, 'public/icon.svg'));
await sharp(icon).resize(300, 300).png({ compressionLevel: 9 }).toFile(path.join(assets, 'linkedin-logo.png'));
// Approved German tagline (§8.1); keep the bottom-left free for LinkedIn's overlay.
const tagline = copy.match(/\[DE\]\n(Praktikums- und Mentoring-CRM:[^\n]+)/)?.[1];
if (!tagline) throw new Error('Canonical LinkedIn tagline missing');
const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="1128" height="191">
<rect width="1128" height="191" fill="#1D4ED8"/>
<circle cx="1080" cy="-30" r="230" fill="#fff" opacity=".055"/>
<circle cx="1080" cy="-30" r="155" fill="none" stroke="#fff" opacity=".15"/>
<text x="228" y="72" font-family="Arial,sans-serif" font-size="40" font-weight="700" fill="#fff">InternCRM</text>
<text x="228" y="112" font-family="Arial,sans-serif" font-size="20" fill="#fff">Praktikums- und Mentoring-CRM: 13 Stufen</text>
<text x="228" y="142" font-family="Arial,sans-serif" font-size="20" fill="#fff">vom Erstkontakt bis zur Einstellung. AGPL-3.0, selbst hostbar.</text>
</svg>`;
if (!tagline.includes('13 Stufen vom Erstkontakt bis zur Einstellung. AGPL-3.0, selbst hostbar.')) throw new Error('Review banner line breaks against changed copy');
await sharp(Buffer.from(banner)).png({ compressionLevel: 9 }).toFile(path.join(assets, 'linkedin-banner.png'));

// Read the one-pager's source text, rather than maintaining another copy bank.
const source = copy.split('## 11. ')[1]?.match(/```text\n([\s\S]*?)```/)?.[1];
if (!source) throw new Error('Canonical German one-pager missing');
const titles = ['DAS PROBLEM', 'WAS INTERNCRM MACHT', 'FÜNF FUNKTIONEN, DIE DEN UNTERSCHIED MACHEN', 'VIER ROLLEN, EINE BEZIEHUNG', 'BETRIEB UND RECHTE', 'WAS HEUTE NICHT GEHT — damit Sie es nicht selbst herausfinden müssen', 'SELBST ANSEHEN — ohne Anmeldung, ein Klick'];
const body = (index) => source.split(titles[index])[1].split(index + 1 < titles.length ? titles[index + 1] : '────────────────')[0].trim();
const paragraphs = (text) => text.split(/\n\s*\n/).map((p) => `<p>${esc(p.replace(/\s+/g, ' ').trim())}</p>`).join('');
// The source uses aligned labels plus wrapped descriptions. Preserve that
// structure as readable paragraphs instead of flattening it into a wall of text.
const definitions = (text) => {
  const items = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\S.*?)\s{2,}(\S.*)$/);
    if (match) items.push({ label: match[1], description: match[2] });
    else if (line.trim() && items.length) items.at(-1).description += ` ${line.trim()}`;
  }
  if (!items.length) throw new Error('Review changed one-pager definition layout');
  return items.map(({ label, description }) => `<p><strong>${esc(label)}</strong> ${esc(description)}</p>`).join('');
};
const image = (name) => `data:image/png;base64,${readFileSync(path.join(root, 'public/screenshots', name)).toString('base64')}`;
const logo = `data:image/svg+xml;base64,${icon.toString('base64')}`;
const html = `<!doctype html><html lang="de"><meta charset="utf-8"><title>InternCRM — Produktübersicht</title>
<style>
@page{size:A4;margin:10mm}*{box-sizing:border-box}body{margin:0;color:#172338;font:9pt/1.2 Arial,sans-serif}header{display:flex;gap:12px;align-items:center;border-bottom:3px solid #1D4ED8;padding-bottom:10px;margin-bottom:10px}header img{width:42px;height:42px}h1{font-size:25pt;letter-spacing:-1px;margin:0;color:#1D4ED8}header p{margin:1px 0 0;font-size:10pt}h2{font-size:9pt;letter-spacing:.5px;color:#1D4ED8;margin:9px 0 5px}p{margin:0 0 4px}.intro{display:grid;grid-template-columns:1fr 1fr;gap:16px}.shots{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0}figure{margin:0}figure img{width:100%;display:block;border:1px solid #dbe3ef;border-radius:5px}figcaption{font-size:7.5pt;color:#52627a;margin-top:3px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:16px}.columns h2:first-child{margin-top:0}.limits{border-left:3px solid #1D4ED8;padding-left:9px;margin-top:10px}.cta{background:#eff6ff;padding:8px;margin-top:10px}.cta h2{margin-top:0}footer{border-top:1px solid #cbd5e1;margin-top:10px;padding-top:6px;font-size:7pt;color:#52627a}a{color:#1D4ED8;text-decoration:none}
</style>
<header><img src="${logo}" alt=""><div><h1>InternCRM</h1><p>Praktikums- und Mentoring-Programme:<br>von der ersten Nachricht bis zur Einstellung</p></div></header>
<div class="intro"><section><h2>${titles[0]}</h2>${paragraphs(body(0))}</section><section><h2>${titles[1]}</h2>${paragraphs(body(1))}</section></div>
<div class="shots"><figure><img src="${image('pipeline-de-light.png')}" alt="Pipeline mit synthetischen Demo-Daten"><figcaption>Pipeline · synthetische Demo-Daten</figcaption></figure><figure><img src="${image('weekly-report-de-light.png')}" alt="Wochenbericht mit synthetischen Demo-Daten"><figcaption>Wochenberichte · synthetische Demo-Daten</figcaption></figure></div>
<div class="columns"><section><h2>${titles[2]}</h2>${definitions(body(2))}<h2>${titles[3]}</h2>${definitions(body(3))}</section><section><h2>${titles[4]}</h2>${definitions(body(4))}<div class="limits"><h2>WAS HEUTE NICHT GEHT</h2>${paragraphs(body(5))}</div><div class="cta"><h2>SELBST ANSEHEN — ohne Anmeldung, ein Klick</h2><p><a href="https://demo.interncrm.com/auth/signin">demo.interncrm.com/auth/signin</a></p><p>Drei Schaltflächen: Programmleitung, Mentorin, Praktikant. Synthetische Daten, zweimal täglich zurückgesetzt, es wird keine E-Mail versendet, Uploads sind abgeschaltet.</p></div></section></div>
<footer>InternCRM · Rechteinhaber: Mehmet Erşahin · <a href="https://interncrm.com/imprint">Impressum und Kontakt: interncrm.com/imprint</a> · Quellcode: github.com/21072026/Internship</footer></html>`;
// Price block intentionally omitted: no unverified deployment price is printed.
// Address/email placeholders become an imprint link; no invented operator identity.
const htmlPath = path.join(output, 'interncrm-one-pager-de.html');
writeFileSync(htmlPath, html);
const browser = await chromium.launch();
try {
  const request = await browser.newContext();
  try {
    const card = await request.request.get(new URL('/opengraph-image', base).href);
    if (!card.ok()) throw new Error(`OG response ${card.status()}`);
    const bytes = await card.body();
    const meta = await sharp(bytes).metadata();
    if (meta.width !== 1200 || meta.height !== 630) throw new Error('OG must be 1200×630');
    await sharp(bytes).raw().toBuffer();
    const pixel = await sharp(bytes).extract({ left: 600, top: 1, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    if (pixel[0] !== 29 || pixel[1] !== 78 || pixel[2] !== 216) throw new Error('OG internship theme must be #1D4ED8');
    writeFileSync(path.join(output, 'og-validation.png'), bytes);
    const landing = await request.newPage();
    await landing.goto(base.href);
    const ogUrl = await landing.locator('meta[property="og:image"]').first().getAttribute('content');
    if (!ogUrl || !/^https?:\/\//.test(ogUrl)) throw new Error('Landing OG metadata must be absolute');
    console.log('OG ImageResponse: 1200×630, #1D4ED8, absolute image metadata');
  } finally { await request.close(); }
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(htmlPath).href);
  await page.evaluate(() => document.fonts.ready);
  if (await page.locator('figure img').count() !== 2) throw new Error('One-pager must contain exactly two product screenshots');
  const pdfPath = path.join(output, 'interncrm-one-pager-de.pdf');
  await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
  const pdf = await PDFDocument.load(readFileSync(pdfPath));
  if (pdf.getPageCount() !== 1) throw new Error(`Expected one A4 page, got ${pdf.getPageCount()}`);
  await page.screenshot({ path: path.join(output, 'one-pager-preview.png'), fullPage: true });
  console.log(`One-pager: ${pdfPath} (one A4 page, two product screenshots)`);
} finally { await browser.close(); }
for (const [name, width, height] of [['linkedin-banner.png', 1128, 191], ['linkedin-logo.png', 300, 300]]) {
  const file = path.join(assets, name);
  const meta = await sharp(file).metadata();
  if (meta.width !== width || meta.height !== height) throw new Error(`Wrong size: ${name}`);
  await sharp(file).raw().toBuffer();
  console.log(`${name}: ${width}×${height}`);
}
