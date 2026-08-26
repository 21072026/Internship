#!/usr/bin/env node
/**
 * Emails the result of a nightly k6 load run, in Turkish, using the same SMTP_*
 * env vars as the app's emailService. Invoked by the `report` job of
 * k6-load.yml.
 *
 * RED-ONLY BY DEFAULT. A green run sends nothing at all — silence *is* the
 * "everything is fine" signal (same call the maintainer made for e2e-full in
 * 2026-08-23: nightly green heartbeats became noise). Set the repository
 * variable K6_REPORT_MODE=always to get a green summary as well.
 *
 * The verdict comes from the k6 summary JSON, not from the workflow's exit
 * code, for one reason: a missing or corrupt summary must count as RED. k6
 * exiting 99 (threshold breach) and k6 crashing before it wrote anything look
 * the same to a workflow condition, and the second one is the more alarming of
 * the two — so it gets its own subject line rather than silence.
 *
 * Env:
 *   K6_SUMMARY_FILE     path to k6's handleSummary JSON (default k6-summary.json)
 *   K6_TARGET_URL       the environment that was tested (shown in the email)
 *   K6_RUN_CONTEXT      free text shown in the email (workflow + run URL)
 *   K6_REPORT_MODE      'failures' (default) | 'always'
 *   K6_REPORT_DRY_RUN   '1' → print the email to stdout, never touch SMTP
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM   (SMTP transport)
 *   ALERT_EMAIL_TO      recipient(s), comma-separated       (required)
 *
 * Exits 0 when the email was sent or gracefully skipped (missing SMTP config, a
 * green run in `failures` mode); exits non-zero only when a send was attempted
 * and failed — so a broken alerting path is visible without masking the load
 * test's own verdict, which the k6 job already reports.
 */
import nodemailer from 'nodemailer';
import { readFileSync } from 'node:fs';

function skip(reason) {
  console.log(`::warning title=k6 report email not sent::${reason}`);
  process.exit(0);
}

// ── Read the summary (defensively — an unreadable summary is itself red) ─────
const summaryFile = process.env.K6_SUMMARY_FILE || 'k6-summary.json';
let summary = null;
let summaryError = null;
try {
  summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
  if (!summary || typeof summary !== 'object' || !summary.metrics) {
    summary = null;
    summaryError = `k6 özeti beklenen biçimde değil (${summaryFile}) — "metrics" alanı yok.`;
  }
} catch (err) {
  summaryError = `k6 özeti okunamadı (${summaryFile}): ${err.message}`;
}

const metrics = summary?.metrics ?? {};

// ── Threshold results ────────────────────────────────────────────────────────
// k6 reports each threshold as metrics[name].thresholds[expression] = { ok };
// some builds store a bare boolean there instead, so accept both.
function thresholdOk(result) {
  if (typeof result === 'object' && result !== null) return result.ok !== false;
  return result !== false;
}

// "p(95)<2500" → { stat: 'p(95)', op: '<', limit: 2500 }. Everything the email
// needs to print "actual vs limit" comes from the expression itself, so a new
// threshold in the k6 script needs no change here.
function parseExpression(expr) {
  // k6 accepts !== / != as well, and parses the limit with strconv.ParseFloat,
  // which takes exponent notation (`rate<1e-3`). Anything this still cannot
  // parse falls back to printing the raw expression rather than blanks.
  const m = /^\s*([a-zA-Z0-9_.()]+)\s*(<=|>=|<|>|===|==|!==|!=)\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*$/.exec(
    expr
  );
  if (!m) return null;
  return { stat: m[1], op: m[2], limit: Number(m[3]) };
}

// Latency-ish values print as ms, rates as a percentage, counters as plain
// integers — a "0.0234" in an alert nobody can read is a wasted alert. The
// summary already carries `type` and `contains` per metric, so read those
// rather than pattern-matching the name: a new scenario's own Trend or Rate
// (the documented extension path) then formats correctly with no change here.
function formatValue(metric, metricName, stat, value) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  const type = metric?.type;
  const isTime = metric?.contains === 'time';
  if (stat === 'count') return String(Math.round(value));
  if (type === 'rate' || (stat === 'rate' && type !== 'counter')) {
    return `%${(value * 100).toFixed(2)}`;
  }
  if (isTime) return `${Math.round(value)}ms`;
  // Fall back to the naming convention for metrics whose type we did not get.
  if (!type && metricName.startsWith('http_req_')) return `${Math.round(value)}ms`;
  return String(Number(value.toFixed(3)));
}

const breaches = [];
// Counted, because "no threshold broke" and "no threshold was ever evaluated"
// are the same thing to `breaches.length`, and the second one must not read as
// a clean night. If a future edit drops `options.thresholds`, misspells the key,
// or nests it where k6 ignores it, k6 exits 0, the job is green, the summary
// parses — and this alert would go silent forever with nothing anywhere to say
// so. Same class of hole `E2E_EXPECTED_REPORTS` guards in the e2e reporter.
let evaluatedThresholds = 0;
for (const [name, metric] of Object.entries(metrics)) {
  for (const [expr, result] of Object.entries(metric?.thresholds ?? {})) {
    evaluatedThresholds += 1;
    if (thresholdOk(result)) continue;
    const parsed = parseExpression(expr);
    const actual = parsed ? metric?.values?.[parsed.stat] : undefined;
    // A threshold on a stat that is not in the scenario's summaryTrendStats
    // has no value to report — say why, rather than printing a bare dash.
    const missingStat = parsed && actual === undefined;
    breaches.push({
      name,
      expr,
      stat: parsed?.stat ?? '',
      op: parsed?.op ?? '',
      parsed: Boolean(parsed),
      actualText: missingStat
        ? `— (summaryTrendStats içinde ${parsed.stat} yok)`
        : parsed
          ? formatValue(metric, name, parsed.stat, actual)
          : '—',
      limitText: parsed ? formatValue(metric, name, parsed.stat, parsed.limit) : '',
    });
  }
}
let noThresholds = false;
if (summaryError === null && evaluatedThresholds === 0) {
  noThresholds = true;
  summaryError =
    'k6 özetinde hiç eşik sonucu yok — betikteki options.thresholds düşmüş, ' +
    'yanlış yazılmış ya da k6\'in görmediği bir yere taşınmış olabilir. ' +
    'Eşik değerlendirilmediği için bu koşu "yeşil" sayılamaz.';
}

// ── Per-endpoint table, built from the {ep:…} sub-metrics ────────────────────
const byEndpoint = new Map();
function endpointRow(ep) {
  if (!byEndpoint.has(ep)) byEndpoint.set(ep, { ep, reqs: null, p95: null, p99: null, failRate: null });
  return byEndpoint.get(ep);
}
for (const [name, metric] of Object.entries(metrics)) {
  const m = /^(http_req_duration|http_req_failed|http_reqs)\{ep:([^}]+)\}$/.exec(name);
  if (!m) continue;
  const row = endpointRow(m[2]);
  if (m[1] === 'http_req_duration') {
    row.p95 = metric?.values?.['p(95)'] ?? null;
    row.p99 = metric?.values?.['p(99)'] ?? null;
  } else if (m[1] === 'http_req_failed') {
    row.failRate = metric?.values?.rate ?? null;
  } else {
    row.reqs = metric?.values?.count ?? null;
  }
}
const breachedEndpoints = new Set(
  breaches.map((b) => /\{ep:([^}]+)\}/.exec(b.name)?.[1]).filter(Boolean)
);

// ── Verdict ──────────────────────────────────────────────────────────────────
const isRed = summaryError !== null || breaches.length > 0;
const mode = process.env.K6_REPORT_MODE || 'failures';

// `=== undefined` alone would let a null stat (what JSON.stringify writes for a
// NaN trend value) render as a confident `0ms`.
const msOrQ = (v) => (v === undefined || v === null ? '?' : `${Math.round(v)}ms`);

const totalReqs = metrics.http_reqs?.values?.count ?? 0;
const failRate = metrics.http_req_failed?.values?.rate ?? 0;
const rps = metrics.http_reqs?.values?.rate ?? 0;
const dur = metrics.http_req_duration?.values ?? {};
const p95 = dur['p(95)'];
const p99 = dur['p(99)'];
const iterations = metrics.iterations?.values?.count ?? 0;

if (mode === 'failures' && !isRed) {
  skip(
    `Koşu yeşil ve K6_REPORT_MODE=failures — k6 özet e-postası atlandı ` +
      `(${totalReqs} istek, p95 ${msOrQ(p95)}).`
  );
}

// ── Compose (Turkish) ────────────────────────────────────────────────────────
const p95Text = msOrQ(p95);
const subject = noThresholds
  ? '❌ Internship CRM — k6: özette hiç eşik yok (yük testi artık hiçbir şeyi ölçmüyor)'
  : summaryError
    ? '❌ Internship CRM — k6: özet raporu okunamadı (koşu muhtemelen çöktü)'
    : breaches.length > 0
      ? `❌ Internship CRM — k6: ${breaches.length} eşik aşıldı (p95 ${p95Text})`
      : `✅ Internship CRM — k6: tüm eşikler içinde (p95 ${p95Text})`;

const lines = [];
if (process.env.K6_TARGET_URL) lines.push(`Hedef: ${process.env.K6_TARGET_URL}`);
if (process.env.K6_RUN_CONTEXT) lines.push(`Koşu:  ${process.env.K6_RUN_CONTEXT}`);

if (summaryError) {
  lines.push('', summaryError, '');
  lines.push(
    ...(noThresholds
      ? [
          'Özet dosyası okundu ve biçimi geçerli, ama içinde tek bir eşik sonucu yok.',
          'Bu, testin geçtiği anlamına gelmez — hiçbir şey ölçülmemiş demektir, ve',
          'sessiz kalmak bu durumu her gece görünmez kılardı. k6/*.js dosyasındaki',
          'options.thresholds tanımını kontrol edin (`npm run check:k6`).',
        ]
      : [
          'k6 özet dosyası üretilmemiş ya da bozuk — test büyük ihtimalle isteklere',
          'başlayamadan çöktü (hedef erişilemez, DNS/TLS hatası, k6 kurulumu vb.).',
          'Workflow koşusunun loglarına bakın.',
        ])
  );
} else {
  lines.push(
    '',
    `Toplam istek: ${totalReqs}`,
    `İterasyon:    ${iterations}`,
    `Hata oranı:   %${(failRate * 100).toFixed(2)}`,
    `Verim:        ${rps.toFixed(1)} istek/sn`,
    `Gecikme:      p95 ${p95Text}   p99 ${msOrQ(p99)}   ` +
      `ort ${msOrQ(dur.avg)}   maks ${msOrQ(dur.max)}`
  );

  if (breaches.length > 0) {
    lines.push('', '--- Aşılan eşikler ---');
    for (const b of breaches) {
      lines.push(
        b.parsed
          ? `✗ ${b.name}: ${b.stat} = ${b.actualText}  (sınır: ${b.op} ${b.limitText})`
          : `✗ ${b.name}: ${b.expr} (aşıldı — ifade çözümlenemedi)`
      );
    }
  } else {
    lines.push('', 'Tüm eşikler sınırlar içinde — sorun yok. 🎉');
  }

  if (byEndpoint.size > 0) {
    lines.push('', '--- Uç nokta özeti ---');
    const pad = (s, n) => String(s).padEnd(n);
    const padL = (s, n) => String(s).padStart(n);
    lines.push(`  ${pad('uç nokta', 14)}${padL('istek', 8)}${padL('p95', 9)}${padL('p99', 9)}${padL('hata', 8)}`);
    for (const row of [...byEndpoint.values()].sort((a, b) => a.ep.localeCompare(b.ep))) {
      const mark = breachedEndpoints.has(row.ep) ? '✗' : ' ';
      // k6 emits zeroed values for a sub-metric that never got a sample, and a
      // row of confident 0ms latencies for an endpoint that was never reached
      // is worse than no number at all.
      const unsampled = !row.reqs;
      const lat = (v) => (unsampled || v === null ? '—' : `${Math.round(v)}ms`);
      lines.push(
        `${mark} ${pad(row.ep, 14)}` +
          padL(row.reqs ?? '—', 8) +
          padL(lat(row.p95), 9) +
          padL(lat(row.p99), 9) +
          padL(unsampled || row.failRate === null ? '—' : `%${(row.failRate * 100).toFixed(1)}`, 8)
      );
    }
  }

  lines.push(
    '',
    'Eşikler k6/nightly-load.js içindeki options.thresholds altında tanımlı;',
    'her birinin gerekçesi aynı dosyada yorum olarak duruyor. Ayrıntı: docs/testing.md'
  );
}

const detail = lines.join('\n');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const heading = isRed ? 'Gece yük testinde sorun var' : 'Gece yük testi temiz';
const color = isRed ? '#b91c1c' : '#15803d';
const html = `<div style="font-family:system-ui,Arial,sans-serif;line-height:1.5">
  <h2 style="color:${color};margin:0 0 8px">${heading}</h2>
  <p><strong>Internship CRM</strong> gece k6 yük testinin özeti:</p>
  <pre style="background:#f3f4f6;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:13px">${escapeHtml(detail)}</pre>
  <p style="color:#6b7280;font-size:12px">Gece k6 yük testi (k6-load workflow'u) tarafından gönderildi. Yanıtlar izlenmiyor.</p>
</div>`;

if (process.env.K6_REPORT_DRY_RUN === '1') {
  console.log(`[dry-run] Subject: ${subject}`);
  console.log(`[dry-run] Body:\n${detail}`);
  process.exit(0);
}

const to = process.env.ALERT_EMAIL_TO;
if (!to) skip('ALERT_EMAIL_TO is not set — no k6 load-test report was delivered.');
if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
  skip(`SMTP is not configured (SMTP_HOST/SMTP_USER) — no k6 report delivered to ${to}.`);
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
  console.log(`k6 report email sent to ${to} (messageId=${info.messageId})`);
} catch (err) {
  console.error('Failed to send k6 report email:', err);
  process.exit(1);
}
