#!/usr/bin/env node
/**
 * Sends a failure-alert email using the same SMTP_* env vars as the app's
 * emailService. Intended to be invoked by CI / the nightly cron when a test
 * job (stress test, e2e, …) fails, so the team is notified without watching
 * the pipeline.
 *
 * Env:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM   (SMTP transport)
 *   ALERT_EMAIL_TO      recipient(s), comma-separated       (required)
 *   ALERT_SUBJECT       subject line                        (optional)
 *   ALERT_BODY          plain-text body / details           (optional)
 *   ALERT_SUMMARY_FILE  path to a JSON summary to attach     (optional)
 *
 * Exits 0 even when SMTP is unconfigured (logs and skips) so it never masks
 * the original test failure in CI; exits non-zero only if sending was
 * attempted and failed.
 */
import nodemailer from 'nodemailer';
import { readFileSync } from 'node:fs';

// Surface a skip as a GitHub Actions warning annotation (visible on the run)
// rather than a silent green step, so a missing secret can't quietly disable
// alerting. Still exits 0 so it never masks the original test failure.
function skip(reason) {
  console.log(`::warning title=Alert email not sent::${reason}`);
  process.exit(0);
}

const to = process.env.ALERT_EMAIL_TO;
if (!to) {
  skip('ALERT_EMAIL_TO secret is not set — no failure alert was delivered.');
}

if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
  skip(`SMTP is not configured (SMTP_HOST/SMTP_USER) — no failure alert delivered to ${to}.`);
}

const subject = process.env.ALERT_SUBJECT || '⚠️ Internship CRM — automated test failure';

let detail = process.env.ALERT_BODY || 'An automated test run failed. See CI logs for details.';
if (process.env.ALERT_SUMMARY_FILE) {
  try {
    detail += `\n\n--- summary ---\n${readFileSync(process.env.ALERT_SUMMARY_FILE, 'utf8')}`;
  } catch {
    /* summary is best-effort */
  }
}

const html = `<div style="font-family:system-ui,Arial,sans-serif;line-height:1.5">
  <h2 style="color:#b91c1c;margin:0 0 8px">Automated test failure</h2>
  <p>An automated test run for <strong>Internship CRM</strong> did not pass.</p>
  <pre style="background:#f3f4f6;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:13px">${escapeHtml(detail)}</pre>
  <p style="color:#6b7280;font-size:12px">Sent by the CI/nightly automation. Reply-to is unmonitored.</p>
</div>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
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
  console.log(`Alert email sent to ${to} (messageId=${info.messageId})`);
} catch (err) {
  console.error('Failed to send alert email:', err);
  process.exit(1);
}
