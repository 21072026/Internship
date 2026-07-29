#!/usr/bin/env node
/**
 * Emails a summary of a Playwright run from its JSON reporter output, using the
 * same SMTP_* env vars as the app's emailService. Invoked by the `report` job of
 * e2e-full.yml after EVERY scheduled full run, so the maintainer gets a
 * "238/238 test geçti" heartbeat — or the failure list — without watching logs.
 *
 * Env:
 *   PLAYWRIGHT_JSON_REPORT  JSON report path; may be a single file, a directory
 *                           (all *.json inside — the sharded-run case), or a
 *                           comma-separated list (default: e2e-report.json)
 *   E2E_EXPECTED_REPORTS    if set (e.g. 4 shards), fewer parsed reports than
 *                           this is reported as a crashed shard (red)
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM   (SMTP transport)
 *   ALERT_EMAIL_TO          recipient(s), comma-separated   (required)
 *   E2E_REPORT_MODE         'always' (default) | 'failures' (only email on red)
 *   E2E_RUN_CONTEXT         free text shown in the email (host, image, date)
 *   E2E_REPORT_DRY_RUN      '1' → print the email to stdout, never touch SMTP
 *
 * Exits 0 when the email was sent or gracefully skipped (missing SMTP config,
 * mode=failures on a green run); exits non-zero only if a send was attempted
 * and failed — so cron surfaces broken alerting without masking test results.
 */
import nodemailer from 'nodemailer';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function skip(reason) {
  console.log(`::warning title=E2E report email not sent::${reason}`);
  process.exit(0);
}

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// ── Locate + parse the Playwright JSON report(s) (defensively — a missing or
//    corrupt report is itself a failure signal, not a reason to crash). A
//    sharded run produces one JSON per shard; point this at the directory. ───
const reportSpec = process.env.PLAYWRIGHT_JSON_REPORT || 'e2e-report.json';
let reportPaths = [];
try {
  if (statSync(reportSpec).isDirectory()) {
    reportPaths = readdirSync(reportSpec)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(reportSpec, f));
  } else {
    reportPaths = [reportSpec];
  }
} catch {
  reportPaths = reportSpec.split(',').map((s) => s.trim()).filter(Boolean);
}

const reports = [];
const parseErrors = [];
for (const p of reportPaths) {
  try {
    reports.push(JSON.parse(readFileSync(p, 'utf8')));
  } catch (err) {
    parseErrors.push(`Rapor okunamadı (${p}): ${err.message}`);
  }
}
const reportError = reports.length === 0
  ? (parseErrors[0] ?? `Hiç JSON raporu bulunamadı (${reportSpec})`)
  : null;

// Fewer reports than expected shards = a shard crashed before writing its
// report; totals below would silently look green without this check.
const expectedReports = Number(process.env.E2E_EXPECTED_REPORTS) || 0;
const missingReports = expectedReports > 0 && reports.length < expectedReports;

const sum = (k) => reports.reduce((acc, r) => acc + (r?.stats?.[k] ?? 0), 0);
const passed = sum('expected');
const failed = sum('unexpected');
const flaky = sum('flaky');
const skipped = sum('skipped');
const total = passed + failed + flaky + skipped;
// Shards run in parallel — wall clock is the slowest shard, not the sum.
const maxDuration = reports.reduce((acc, r) => Math.max(acc, r?.stats?.duration ?? 0), 0);
const durationMin = maxDuration ? (maxDuration / 60000).toFixed(1) : '?';

// Walk nested suites for failing specs: file, title chain, first error snippet.
const failures = [];
function walkSuites(suites, chain) {
  for (const suite of suites ?? []) {
    const nextChain = suite.title ? [...chain, suite.title] : chain;
    for (const spec of suite.specs ?? []) {
      if (spec.ok === false) {
        let error = '';
        for (const t of spec.tests ?? []) {
          const bad = (t.results ?? []).find((r) => r.error?.message);
          if (bad) {
            error = stripAnsi(bad.error.message).slice(0, 500);
            break;
          }
        }
        failures.push({
          file: spec.file || suite.file || '?',
          title: [...nextChain, spec.title].filter(Boolean).join(' › '),
          error,
        });
      }
    }
    walkSuites(suite.suites, nextChain);
  }
}
for (const r of reports) walkSuites(r?.suites, []);

const isRed =
  reportError !== null || failed > 0 || failures.length > 0 || missingReports || parseErrors.length > 0;
const mode = process.env.E2E_REPORT_MODE || 'always';
if (mode === 'failures' && !isRed) {
  skip(`Koşu yeşil ve E2E_REPORT_MODE=failures — özet e-postası atlandı (${passed}/${total} geçti).`);
}

// ── Compose (Turkish) ────────────────────────────────────────────────────────
const subject = reportError
  ? '❌ Internship CRM — e2e: rapor üretilemedi (koşu muhtemelen çöktü)'
  : failed > 0 || failures.length > 0
    ? `❌ Internship CRM — e2e: ${failed} test BAŞARISIZ (${passed}/${total})`
    : missingReports || parseErrors.length > 0
      ? `❌ Internship CRM — e2e: eksik rapor (${reports.length}/${expectedReports} shard) — bir shard çökmüş olabilir`
      : `✅ Internship CRM — e2e: ${passed}/${total} test geçti`;

const lines = [];
if (process.env.E2E_RUN_CONTEXT) lines.push(`Koşu: ${process.env.E2E_RUN_CONTEXT}`);
if (reportError) {
  lines.push('', reportError, '', 'Playwright JSON raporu bulunamadı veya bozuk — koşu büyük ihtimalle testlere gelemeden çöktü. Workflow koşusunun loglarına bakın.');
} else {
  lines.push(
    '',
    `Toplam:     ${total}`,
    `Geçen:      ${passed}`,
    `Başarısız:  ${failed}`,
    `Flaky:      ${flaky}`,
    `Atlanan:    ${skipped}`,
    `Süre:       ${durationMin} dk${reports.length > 1 ? ` (${reports.length} paralel shard, en yavaşı)` : ''}`
  );
  if (missingReports) {
    lines.push('', `⚠️ ${expectedReports} shard'dan yalnızca ${reports.length} rapor üretti — eksik shard'lar testlere gelemeden çökmüş olabilir; workflow koşusundaki loglara bakın.`);
  }
  for (const e of parseErrors) lines.push('', `⚠️ ${e}`);
  if (failures.length > 0) {
    lines.push('', '--- Başarısız testler ---');
    for (const f of failures) {
      lines.push('', `✗ ${f.file} › ${f.title}`);
      if (f.error) lines.push(f.error.split('\n').map((l) => `    ${l}`).join('\n'));
    }
  } else if (!isRed) {
    lines.push('', 'Her şey yolunda — başarısız test yok. 🎉');
  }
}
const detail = lines.join('\n');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const heading = isRed ? 'E2E koşusunda sorun var' : 'E2E koşusu temiz';
const color = isRed ? '#b91c1c' : '#15803d';
const html = `<div style="font-family:system-ui,Arial,sans-serif;line-height:1.5">
  <h2 style="color:${color};margin:0 0 8px">${heading}</h2>
  <p><strong>Internship CRM</strong> zamanlanmış tam e2e koşusunun özeti:</p>
  <pre style="background:#f3f4f6;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:13px">${escapeHtml(detail)}</pre>
  <p style="color:#6b7280;font-size:12px">Zamanlanmış tam e2e koşusu (e2e-full workflow'u) tarafından gönderildi. Yanıtlar izlenmiyor.</p>
</div>`;

if (process.env.E2E_REPORT_DRY_RUN === '1') {
  console.log(`[dry-run] Subject: ${subject}`);
  console.log(`[dry-run] Body:\n${detail}`);
  process.exit(0);
}

const to = process.env.ALERT_EMAIL_TO;
if (!to) skip('ALERT_EMAIL_TO is not set — no e2e report was delivered.');
if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
  skip(`SMTP is not configured (SMTP_HOST/SMTP_USER) — no e2e report delivered to ${to}.`);
}

const port = Number(process.env.SMTP_PORT) || 587;
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: port === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

try {
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text: detail,
    html,
  });
  console.log(`E2E report email sent to ${to} (messageId=${info.messageId})`);
} catch (err) {
  console.error('Failed to send e2e report email:', err);
  process.exit(1);
}
