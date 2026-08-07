import nodemailer from 'nodemailer';
import cron from 'node-cron';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { getSetting } from '@/lib/settings';
import { emailAllowed } from '@/lib/notificationPrefs';
import { makeConsentRenewToken } from '@/lib/consentRenew';
import { getRetentionMonths, RETENTION_GRACE_DAYS } from '@/lib/retention';
import { getMentorMenteeActivity, getSystemMenteeActivity, formatDuration, type MenteeActivity } from '@/lib/activityReport';
import { getOrgBranding } from '@/lib/orgBranding';
import { formatInTimeZone } from '@/lib/timezone';
import { seriesOccurrences } from '@/lib/meetingSeriesOccurrences';
import { loadProjectTeam } from '@/lib/projectTeam';
import { getDictionary } from '@/i18n/dictionaries';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';

// Resolved branding for a transactional email (#546). When no orgId is given
// (single-tenant, or a caller without tenant context) this returns the product
// defaults, so behavior is unchanged. The accent falls back to the product blue.
const DEFAULT_ACCENT = '#2563eb';
async function emailBrand(orgId?: string | null) {
  const b = await getOrgBranding(orgId ?? null);
  return {
    name: b.name,
    accent: b.color || DEFAULT_ACCENT,
    logoUrl: b.logoUrl,
    supportEmail: b.supportEmail,
  };
}

// A small brand header (logo if the tenant set one, otherwise the heading text).
function brandHeader(brand: { name: string; accent: string; logoUrl: string | null }, heading: string): string {
  const logo = brand.logoUrl
    ? `<img src="${brand.logoUrl}" alt="${brand.name}" style="max-height:40px;margin-bottom:12px;" />`
    : '';
  return `${logo}<h2 style="color: ${brand.accent};">${heading}</h2>`;
}

const smtpPort = Number(process.env.SMTP_PORT) || 587;
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Best-effort HTML → plain text for the multipart alternative. A message with
// only an HTML part scores worse with spam filters (e.g. Gmail); shipping a
// text/plain alternative alongside improves inbox placement.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// A From header with a display name ("Internship CRM <noreply@…>") looks less
// like bulk/spam than a bare address. Honor an address that already includes a
// name; otherwise wrap the configured address.
function fromHeader(brandName?: string | null): string {
  const addr = process.env.SMTP_FROM || process.env.SMTP_USER || '';
  if (addr.includes('<') || !addr) return addr;
  const name = brandName || process.env.MAIL_FROM_NAME || 'Internship CRM';
  return `${name} <${addr}>`;
}

export async function sendEmail({
  to,
  subject,
  html,
  replyTo,
  attachments,
  fromName,
}: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  // `cid` makes an attachment *inline*: the HTML can then reference it as
  // <img src="cid:…">, which is how images inside a message body reach mail
  // clients (a URL into this app would need a session and render as broken).
  attachments?: { filename: string; content: Buffer; contentType?: string; cid?: string }[];
  // Overrides the From display name (e.g. a tenant's brand name, #546). Falls
  // back to MAIL_FROM_NAME / "Internship CRM" when omitted.
  fromName?: string | null;
}) {
  if (!process.env.SMTP_USER) {
    console.log(`[Email skipped - no SMTP config] To: ${to}, Subject: ${subject}`);
    return;
  }

  await transporter.sendMail({
    from: fromHeader(fromName),
    to,
    subject,
    html,
    text: htmlToText(html),
    ...(replyTo ? { replyTo } : {}),
    ...(attachments?.length ? { attachments } : {}),
  });
}

// Connectivity-only check (auth + reachability), no message sent — used by the
// opt-in `/api/health?smtp=1` probe so SMTP outages (#483) surface as a clear
// signal instead of only being visible per-user as "email never arrived".
export async function verifySmtpConnection(): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.SMTP_USER) return { ok: false, error: 'SMTP not configured' };
  try {
    await transporter.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function sendInvitationEmail({
  to,
  token,
  role,
  orgId,
}: {
  to: string;
  token: string;
  role: string;
  orgId?: string | null;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const registerUrl = `${appUrl}/auth/register?token=${token}`;
  const brand = await emailBrand(orgId);

  await sendEmail({
    to,
    fromName: brand.name,
    subject: `You have been invited to ${brand.name}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, `Welcome to ${brand.name}`)}
        <p>You have been invited to join as a <strong>${role}</strong>.</p>
        <p>Click the button below to complete your registration:</p>
        <a href="${registerUrl}" style="
          display: inline-block;
          background-color: ${brand.accent};
          color: white;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 6px;
          margin: 16px 0;
        ">
          Accept Invitation
        </a>
        <p style="color: #6b7280; font-size: 14px;">
          This invitation will expire in 7 days. If you did not expect this email, please ignore it.
        </p>
        <p style="color: #6b7280; font-size: 12px;">
          Or copy this link: ${registerUrl}
        </p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail({
  to,
  token,
  fullName,
  purpose = 'RESET',
  orgId,
}: {
  to: string;
  token: string;
  fullName?: string | null;
  purpose?: 'RESET' | 'SET_INITIAL';
  orgId?: string | null;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const resetUrl = `${appUrl}/auth/reset?token=${token}`;
  const isInitial = purpose === 'SET_INITIAL';
  const brand = await emailBrand(orgId);

  const heading = isInitial ? 'Set your password' : 'Reset your password';
  const intro = isInitial
    ? `An account has been created for you on ${brand.name}. Set a password to activate it and sign in.`
    : 'We received a request to reset your password. Click the button below to choose a new one.';
  const cta = isInitial ? 'Set password' : 'Reset password';

  await sendEmail({
    to,
    fromName: brand.name,
    subject: isInitial ? `Activate your ${brand.name} account` : `Reset your ${brand.name} password`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, heading)}
        ${fullName ? `<p>Hi ${fullName},</p>` : ''}
        <p>${intro}</p>
        <a href="${resetUrl}" style="
          display: inline-block;
          background-color: ${brand.accent};
          color: white;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 6px;
          margin: 16px 0;
        ">
          ${cta}
        </a>
        <p style="color: #6b7280; font-size: 14px;">
          This link expires in ${isInitial ? '7 days' : '1 hour'}. If you did not expect this email, you can safely ignore it.
        </p>
        <p style="color: #6b7280; font-size: 12px;">
          Or copy this link: ${resetUrl}
        </p>
      </div>
    `,
  });
}

export async function sendVerificationEmail({
  to,
  token,
  fullName,
  orgId,
}: {
  to: string;
  token: string;
  fullName?: string | null;
  orgId?: string | null;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const verifyUrl = `${appUrl}/auth/verify?token=${token}`;
  const brand = await emailBrand(orgId);

  await sendEmail({
    to,
    fromName: brand.name,
    subject: `Verify your ${brand.name} email`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'Confirm your email')}
        ${fullName ? `<p>Hi ${fullName},</p>` : ''}
        <p>Please confirm your email address to activate full access to your account.</p>
        <a href="${verifyUrl}" style="
          display: inline-block;
          background-color: ${brand.accent};
          color: white;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 6px;
          margin: 16px 0;
        ">
          Verify email
        </a>
        <p style="color: #6b7280; font-size: 14px;">
          This link expires in 24 hours. Until you verify, your account has read-only access.
        </p>
        <p style="color: #6b7280; font-size: 12px;">
          Or copy this link: ${verifyUrl}
        </p>
      </div>
    `,
  });
}

export async function sendMeetingInviteEmail({
  to,
  fullName,
  title,
  scheduledAt,
  meetLink,
  rsvpToken,
  timeZone,
}: {
  to: string;
  fullName?: string | null;
  title: string;
  scheduledAt: Date | null;
  meetLink?: string | null;
  // Omitted for announcements that have no Meeting row behind them — a
  // recurring series occurrence is computed from the rule, so there is nothing
  // to RSVP against and the buttons are left out.
  rsvpToken?: string | null;
  // The recipient's saved IANA zone; falls back to the deployment default.
  timeZone?: string | null;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const yes = `${appUrl}/rsvp/${rsvpToken}?r=yes`;
  const no = `${appUrl}/rsvp/${rsvpToken}?r=no`;
  // A meeting with no set time is just a shared link — skip the "when" line and
  // the RSVP ask entirely.
  const when = scheduledAt ? formatInTimeZone(scheduledAt, timeZone, { dateStyle: 'full', timeStyle: 'short' }) : null;
  const askRsvp = Boolean(when && rsvpToken);

  await sendEmail({
    to,
    subject: `Meeting invitation: ${title}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">${title}</h2>
        ${fullName ? `<p>Hi ${fullName},</p>` : ''}
        <p>You're invited to a meeting.</p>
        ${when ? `<p><strong>When:</strong> ${when}</p>` : ''}
        ${meetLink ? `<p><strong>Meeting link:</strong> <a href="${meetLink}">${meetLink}</a></p>` : ''}
        ${askRsvp ? `
        <p style="margin-top: 20px;">Can you make it?</p>
        <a href="${yes}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;margin-right:8px;">Yes, I'll attend</a>
        <a href="${no}" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Can't attend</a>
        ` : ''}
      </div>
    `,
  });
}

// Minimal HTML escape for user-supplied strings interpolated into templates
// (names, free-text messages) — keeps a stray "<" from breaking the markup.
function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string);
}

// A branded button + wrapper shared by the notification templates below.
function ctaBlock(brand: { accent: string }, url: string, label: string): string {
  return `<a href="${url}" style="display:inline-block;background-color:${brand.accent};color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;margin:16px 0;">${label}</a>`;
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

// --- Mentorship request lifecycle (#668) ------------------------------------
// These events previously produced an in-app notification only, so a mentee who
// wasn't logged in never learned their request had been decided.

export async function sendMentorshipDecisionEmail({
  to,
  fullName,
  approved,
  mentorName,
  orgId,
}: {
  to: string;
  fullName?: string | null;
  approved: boolean;
  mentorName?: string | null;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const heading = approved ? 'Your mentorship request was approved' : 'Update on your mentorship request';
  const body = approved
    ? `<p>Good news — your mentorship request has been approved${mentorName ? ` and <strong>${esc(mentorName)}</strong> is now your mentor` : ''}. Open your portal to say hi and get started.</p>`
    : `<p>Your mentorship request has been reviewed, but it could not be approved right now. You are welcome to submit a new request later — keeping your profile and CV up to date helps.</p>`;

  await sendEmail({
    to,
    fromName: brand.name,
    subject: approved ? `Your mentorship request was approved` : `Update on your mentorship request`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, heading)}
        ${fullName ? `<p>Hi ${esc(fullName)},</p>` : ''}
        ${body}
        ${ctaBlock(brand, `${appUrl()}/portal`, 'Open your portal')}
      </div>
    `,
  });
}

export async function sendMenteeAssignedEmail({
  to,
  mentorName,
  menteeName,
  orgId,
}: {
  to: string;
  mentorName?: string | null;
  menteeName: string;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  await sendEmail({
    to,
    fromName: brand.name,
    subject: `New mentee assigned: ${menteeName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'You have a new mentee')}
        ${mentorName ? `<p>Hi ${esc(mentorName)},</p>` : ''}
        <p><strong>${esc(menteeName)}</strong> has been assigned to you as a mentee. Reach out to
        them to get the mentorship started, and log your first interaction when you do.</p>
        ${ctaBlock(brand, `${appUrl()}/mentor`, 'Open your dashboard')}
      </div>
    `,
  });
}

// An admin wiring up a mentorship directly (no prior mentee request, #668) —
// the mentee never asked, so the request-approval copy would not fit.
export async function sendMentorAssignedEmail({
  to,
  menteeName,
  mentorName,
  orgId,
}: {
  to: string;
  menteeName?: string | null;
  mentorName: string;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  await sendEmail({
    to,
    fromName: brand.name,
    subject: `You have a mentor: ${mentorName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'You have been assigned a mentor')}
        ${menteeName ? `<p>Hi ${esc(menteeName)},</p>` : ''}
        <p><strong>${esc(mentorName)}</strong> is now your mentor. Open your portal to say hi
        and get the mentorship started.</p>
        ${ctaBlock(brand, `${appUrl()}/portal`, 'Open your portal')}
      </div>
    `,
  });
}

export async function sendMentorshipRequestEmail({
  to,
  adminName,
  menteeName,
  targetPosition,
  message,
  orgId,
}: {
  to: string;
  adminName?: string | null;
  menteeName: string;
  targetPosition?: string | null;
  message?: string | null;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  await sendEmail({
    to,
    fromName: brand.name,
    subject: `New mentorship request: ${menteeName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'New mentorship request')}
        ${adminName ? `<p>Hi ${esc(adminName)},</p>` : ''}
        <p><strong>${esc(menteeName)}</strong> asked to be matched with a mentor${targetPosition ? ` (target position: ${esc(targetPosition)})` : ''}.</p>
        ${message ? `<blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444;">${esc(message)}</blockquote>` : ''}
        ${ctaBlock(brand, `${appUrl()}/admin/mentorship`, 'Review the request')}
      </div>
    `,
  });
}

// --- Mentor applications (#904/#905/#933) -----------------------------------
// The only transactional emails in this file localized to the recipient: the
// applicant is never a signed-in User with an account-level language, so the
// `locale` captured on submit (src/app/apply-as-mentor/page.tsx) is all we have.
function resolveLocale(locale?: string | null): Locale {
  return isLocale(locale ?? undefined) ? (locale as Locale) : defaultLocale;
}

export async function sendMentorApplicationReceivedEmail({
  to,
  fullName,
  locale,
  orgId,
}: {
  to: string;
  fullName: string;
  locale?: string | null;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const M = getDictionary(resolveLocale(locale)).mentorApplicationEmail;
  await sendEmail({
    to,
    fromName: brand.name,
    subject: M.received.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, M.received.heading)}
        <p>${esc(M.greeting.replace('{name}', fullName))}</p>
        <p>${esc(M.received.body)}</p>
      </div>
    `,
  });
}

export async function sendMentorApplicationUnderReviewEmail({
  to,
  fullName,
  locale,
  orgId,
}: {
  to: string;
  fullName: string;
  locale?: string | null;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const M = getDictionary(resolveLocale(locale)).mentorApplicationEmail;
  await sendEmail({
    to,
    fromName: brand.name,
    subject: M.underReview.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, M.underReview.heading)}
        <p>${esc(M.greeting.replace('{name}', fullName))}</p>
        <p>${esc(M.underReview.body)}</p>
      </div>
    `,
  });
}

// `registerUrl` set → no account existed yet, an invitation token was created
// (mirrors sendInvitationEmail's link). Omitted → an existing account was
// promoted to MENTOR in place, so the CTA is just "sign in".
export async function sendMentorApplicationApprovedEmail({
  to,
  fullName,
  locale,
  orgId,
  registerUrl,
}: {
  to: string;
  fullName: string;
  locale?: string | null;
  orgId?: string | null;
  registerUrl?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const M = getDictionary(resolveLocale(locale)).mentorApplicationEmail;
  const isNewAccount = !!registerUrl;
  await sendEmail({
    to,
    fromName: brand.name,
    subject: M.approved.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, M.approved.heading)}
        <p>${esc(M.greeting.replace('{name}', fullName))}</p>
        <p>${esc(isNewAccount ? M.approved.bodyNewAccount : M.approved.bodyExistingAccount)}</p>
        ${ctaBlock(brand, registerUrl || `${appUrl()}/auth/signin`, isNewAccount ? M.approved.ctaRegister : M.approved.ctaSignIn)}
      </div>
    `,
  });
}

// The rejection *reason* an admin records is internal-only (never sent here) —
// the applicant gets a generic, kind decline instead.
export async function sendMentorApplicationRejectedEmail({
  to,
  fullName,
  locale,
  orgId,
}: {
  to: string;
  fullName: string;
  locale?: string | null;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const M = getDictionary(resolveLocale(locale)).mentorApplicationEmail;
  await sendEmail({
    to,
    fromName: brand.name,
    subject: M.rejected.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, M.rejected.heading)}
        <p>${esc(M.greeting.replace('{name}', fullName))}</p>
        <p>${esc(M.rejected.body)}</p>
      </div>
    `,
  });
}

// --- Meeting requests (#668) ------------------------------------------------

export async function sendMeetingRequestEmail({
  to,
  fullName,
  requesterName,
  topic,
  proposedAt,
  link,
  orgId,
  timeZone,
}: {
  to: string;
  fullName?: string | null;
  requesterName: string;
  topic: string;
  proposedAt: Date | null;
  link: string;
  orgId?: string | null;
  timeZone?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const when = proposedAt ? formatInTimeZone(proposedAt, timeZone, { dateStyle: 'full', timeStyle: 'short' }) : null;
  await sendEmail({
    to,
    fromName: brand.name,
    subject: `Meeting request: ${topic}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'New meeting request')}
        ${fullName ? `<p>Hi ${esc(fullName)},</p>` : ''}
        <p><strong>${esc(requesterName)}</strong> requested a meeting: <strong>${esc(topic)}</strong>.</p>
        ${when ? `<p><strong>Proposed time:</strong> ${when}</p>` : ''}
        ${ctaBlock(brand, `${appUrl()}${link}`, 'Accept or decline')}
      </div>
    `,
  });
}

export async function sendMeetingRequestDecisionEmail({
  to,
  fullName,
  topic,
  accepted,
  scheduledAt,
  meetLink,
  link,
  orgId,
  timeZone,
}: {
  to: string;
  fullName?: string | null;
  topic: string;
  accepted: boolean;
  scheduledAt?: Date | null;
  meetLink?: string | null;
  link: string;
  orgId?: string | null;
  timeZone?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const when = scheduledAt ? formatInTimeZone(scheduledAt, timeZone, { dateStyle: 'full', timeStyle: 'short' }) : null;
  await sendEmail({
    to,
    fromName: brand.name,
    subject: accepted ? `Meeting confirmed: ${topic}` : `Meeting request declined: ${topic}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, accepted ? 'Your meeting is confirmed' : 'Your meeting request was declined')}
        ${fullName ? `<p>Hi ${esc(fullName)},</p>` : ''}
        ${accepted
          ? `<p>Your meeting request <strong>${esc(topic)}</strong> was accepted.</p>
             ${when ? `<p><strong>When:</strong> ${when}</p>` : ''}
             ${meetLink ? `<p><strong>Meeting link:</strong> <a href="${meetLink}">${meetLink}</a></p>` : ''}`
          : `<p>Your meeting request <strong>${esc(topic)}</strong> could not be accepted. You can propose another time.</p>`}
        ${ctaBlock(brand, `${appUrl()}${link}`, 'Open the conversation')}
      </div>
    `,
  });
}

// --- Public profile contact form (#668) -------------------------------------
// An outside enquiry (e.g. a recruiter) is the most time-sensitive thing a
// profile owner can receive, and it was in-app only. Reply-To is set to the
// sender so the owner can answer straight from their inbox.

export async function sendPublicContactEmail({
  to,
  ownerName,
  fromName,
  fromEmail,
  message,
  orgId,
}: {
  to: string;
  ownerName?: string | null;
  fromName: string;
  fromEmail: string;
  message: string;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  await sendEmail({
    to,
    fromName: brand.name,
    replyTo: fromEmail,
    subject: `New message from your public profile: ${fromName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'Someone contacted you')}
        ${ownerName ? `<p>Hi ${esc(ownerName)},</p>` : ''}
        <p><strong>${esc(fromName)}</strong> (${esc(fromEmail)}) sent you a message through your public profile:</p>
        <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444;">${esc(message).replace(/\n/g, '<br>')}</blockquote>
        <p style="color:#6b7280;font-size:14px;">Reply to this email to answer them directly.</p>
      </div>
    `,
  });
}

// A company enquiry from the public /for-companies page, mailed to every admin.
// Reply-To is the company's address, so answering is one click — this is the
// most time-sensitive thing the public site produces.
export async function sendCompanyInquiryEmail({
  to,
  adminName,
  companyName,
  contactName,
  fromEmail,
  phone,
  openRoles,
  message,
  locale,
  orgId,
}: {
  to: string;
  adminName?: string | null;
  companyName: string;
  contactName: string;
  fromEmail: string;
  phone?: string | null;
  openRoles?: string | null;
  message?: string | null;
  locale?: string | null;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const M = getDictionary(resolveLocale(locale)).companyInquiryEmail;
  await sendEmail({
    to,
    fromName: brand.name,
    replyTo: fromEmail,
    subject: `${M.subject}: ${companyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, M.heading)}
        ${adminName ? `<p>${esc(M.greeting.replace('{name}', adminName))}</p>` : ''}
        <p><strong>${esc(companyName)}</strong> — ${esc(contactName)} (${esc(fromEmail)})</p>
        ${phone ? `<p>${esc(M.phone)}: ${esc(phone)}</p>` : ''}
        ${openRoles ? `<p>${esc(M.openRoles)}: ${esc(openRoles)}</p>` : ''}
        ${message ? `<blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444;">${esc(message).replace(/\n/g, '<br>')}</blockquote>` : ''}
        <p style="color:#6b7280;font-size:14px;">${esc(M.replyHint)}</p>
      </div>
    `,
  });
}

// --- Project join requests (#51) --------------------------------------------

export async function sendProjectJoinRequestEmail({
  to,
  fullName,
  projectId,
  projectName,
  requesterName,
  message,
  recipient,
  orgId,
}: {
  to: string;
  fullName?: string | null;
  projectId: string;
  projectName: string;
  requesterName: string;
  message?: string | null;
  // Preferences are honoured here rather than at the call site so no caller can
  // forget: this is a 'mentorship'-category notification (someone wants in).
  recipient: { emailNotifications?: boolean | null; notificationPrefs?: unknown };
  orgId?: string | null;
}) {
  if (!to || !emailAllowed(recipient, 'mentorship')) return;
  const brand = await emailBrand(orgId);
  await sendEmail({
    to,
    fromName: brand.name,
    subject: `Join request: ${requesterName} → ${projectName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'Someone wants to join your project')}
        ${fullName ? `<p>Hi ${esc(fullName)},</p>` : ''}
        <p><strong>${esc(requesterName)}</strong> asked to join <strong>${esc(projectName)}</strong>.</p>
        ${message ? `<blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444;">${esc(message).replace(/\n/g, '<br>')}</blockquote>` : ''}
        ${ctaBlock(brand, `${appUrl()}/projects/${projectId}`, 'Review the request')}
      </div>
    `,
  });
}

export async function checkMentorInteractionReminders() {
  const days = parseInt(await getSetting('reminderDays'), 10) || 14;
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - days);

  const activeRelations = await prisma.mentorshipRelation.findMany({
    where: { status: 'ACTIVE' },
    include: {
      mentor: true,
      mentee: true,
      interactions: {
        orderBy: { date: 'desc' },
        take: 1,
      },
    },
  });

  const remindersToSend: typeof activeRelations = [];

  for (const relation of activeRelations) {
    const lastInteraction = relation.interactions[0];
    const stale = !lastInteraction || lastInteraction.date < fourteenDaysAgo;
    if (stale) {
      remindersToSend.push(relation);
      // In-app notification once per staleness episode (#573): only when we
      // haven't already flagged this stretch of inactivity. In-app bell items
      // are always created (consistent with deadline/retention notifications);
      // email opt-out is handled separately below.
      if (!relation.stalenessReminderSentAt) {
        await notify(
          relation.mentorId,
          'stale_mentee',
          `No recent contact with ${relation.mentee.fullName}.`,
          `/mentor/mentees/${relation.id}`
        );
        await prisma.mentorshipRelation.update({
          where: { id: relation.id },
          data: { stalenessReminderSentAt: new Date() },
        });
      }
    } else if (relation.stalenessReminderSentAt) {
      // Mentee is active again — clear the flag so a future staleness episode
      // re-notifies the mentor.
      await prisma.mentorshipRelation.update({
        where: { id: relation.id },
        data: { stalenessReminderSentAt: null },
      });
    }
  }

  // One email per MENTOR, not per relation. This job runs daily, so a mentor
  // with 7 stale mentees used to get 7 separate mails every single day — and
  // unlike every other scheduled job it never consulted the recipient's
  // preferences, so there was no way to turn them off. Grouped + opt-out aware
  // ('deadlines', the same category as the stage-deadline nudge): one summary
  // listing each mentee and how long it has been.
  const byMentor = new Map<string, typeof remindersToSend>();
  for (const relation of remindersToSend) {
    const list = byMentor.get(relation.mentorId) ?? [];
    list.push(relation);
    byMentor.set(relation.mentorId, list);
  }

  let emailed = 0;
  for (const relations of byMentor.values()) {
    const mentor = relations[0].mentor;
    if (!mentor.email || !emailAllowed(mentor, 'deadlines')) continue;

    const rows = relations
      .map((relation) => {
        const lastDate = relation.interactions[0]?.date;
        const daysSince = lastDate
          ? Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24))
          : null;
        const since = daysSince !== null
          ? `${daysSince} day${daysSince === 1 ? '' : 's'} since the last interaction`
          : 'no interactions logged yet';
        return `<li style="margin-bottom:6px;"><strong>${relation.mentee.fullName}</strong> — ${since}</li>`;
      })
      .join('');

    try {
      await sendEmail({
        to: mentor.email,
        subject: relations.length === 1
          ? `Reminder: Log interaction with ${relations[0].mentee.fullName}`
          : `Reminder: ${relations.length} mentees need an interaction log`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2563eb;">Interaction Reminder</h2>
            <p>Hi ${mentor.fullName},</p>
            <p>These mentees have had no logged interaction for a while:</p>
            <ul style="padding-left:18px;">${rows}</ul>
            <p>Please log your recent interactions to keep the mentorship record up to date.</p>
            <a href="${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/mentor" style="
              display: inline-block;
              background-color: #2563eb;
              color: white;
              padding: 12px 24px;
              text-decoration: none;
              border-radius: 6px;
              margin: 16px 0;
            ">
              Go to Mentor Dashboard
            </a>
          </div>
        `,
      });
      emailed++;
    } catch (e) {
      console.error('checkMentorInteractionReminders email failed:', { mentorId: relations[0].mentorId, error: e });
    }
  }

  return {
    checked: activeRelations.length,
    reminded: remindersToSend.length,
    emailed,
  };
}

// Notify mentors about mentees whose current stage deadline has passed. Each
// relation is reminded once per deadline (deadlineReminderSentAt guards it).
export async function checkStageDeadlineReminders() {
  const now = new Date();
  const TERMINAL = ['HIRED_660', 'EMPLOYED_700', 'INTERNSHIP_FOUND_ELSEWHERE_800'] as const;

  const overdue = await prisma.mentorshipRelation.findMany({
    where: {
      status: 'ACTIVE',
      stageDeadline: { lt: now },
      deadlineReminderSentAt: null,
      pipelineStatus: { notIn: [...TERMINAL] },
    },
    include: {
      mentor: {
        select: {
          email: true,
          fullName: true,
          emailNotifications: true,
          notificationPrefs: true,
          preferredLanguage: true,
        },
      },
      mentee: { select: { fullName: true } },
    },
  });

  for (const rel of overdue) {
    await notify(rel.mentorId, 'deadline', `Stage deadline passed for ${rel.mentee.fullName}.`, `/admin/candidates/${rel.menteeId}`);
    if (emailAllowed(rel.mentor, 'deadlines')) {
      const preferredLanguage = rel.mentor.preferredLanguage ?? undefined;
      const locale = isLocale(preferredLanguage) ? preferredLanguage : defaultLocale;
      const emailText = getDictionary(locale).notifications.deadlineEmail;
      const subject = emailText.subject.replace('{mentee}', rel.mentee.fullName);
      const greeting = emailText.greeting.replace('{mentor}', rel.mentor.fullName);
      const body = emailText.body.replace('{mentee}', `<strong>${rel.mentee.fullName}</strong>`);
      await sendEmail({
        to: rel.mentor.email,
        subject,
        html: `<p>${greeting}</p><p>${body}</p>`,
      }).catch((error) => {
        console.error('checkStageDeadlineReminders email failed:', { relationId: rel.id, mentorId: rel.mentorId, error });
      });
    }
    await prisma.mentorshipRelation.update({ where: { id: rel.id }, data: { deadlineReminderSentAt: now } });
  }

  return { reminded: overdue.length };
}

// How far ahead a meeting reminder fires. The cron ticks every 15 minutes
// (see initCronJobs), so a meeting is reminded 45-60 minutes before it starts —
// close enough to "one hour before" to be useful, and never late.
export const MEETING_REMINDER_WINDOW_MINUTES = 60;

// Reminders for meetings starting within the next ~60 minutes that haven't been
// reminded yet (#777).
//
//   • in-app: EVERY participant (mentee *and* mentor) is notified, always —
//     bell items are not subject to the email category opt-outs.
//   • email: only participants whose 'meetingReminders' category is on.
//
// Idempotency: `reminderSentAt` is claimed *before* anything is sent, with a
// `reminderSentAt: null` guard so an overlapping cron tick can't double-send.
// Marking first means a mid-send failure loses a reminder rather than
// duplicating one — the far less annoying failure mode, and it keeps the in-app
// notification and the email behind the same single marker.
export async function sendMeetingReminders() {
  const now = new Date();
  const horizon = new Date(now.getTime() + MEETING_REMINDER_WINDOW_MINUTES * 60 * 1000);
  const participantSelect = {
    id: true,
    email: true,
    fullName: true,
    role: true,
    orgId: true,
    emailNotifications: true,
    notificationPrefs: true,
    timezone: true,
  } as const;

  const meetings = await prisma.meeting.findMany({
    // `seriesId: null` — a recurring project meeting is reminded by
    // sendProjectMeetingSeriesReminders(), which covers the whole project team
    // rather than only the two sides of a relation. Without this exclusion the
    // people who have both a relation and a membership got the hour-before
    // reminder twice (#51).
    // `relationId: { not: null }` — a project/conversation meeting (#1051) has
    // no two-sided relation to remind; those rooms are instant and time-less,
    // so they never match the scheduledAt window either.
    where: {
      scheduledAt: { gt: now, lte: horizon },
      reminderSentAt: null,
      seriesId: null,
      relationId: { not: null },
    },
    include: {
      relation: {
        include: {
          mentee: { select: participantSelect },
          mentor: { select: participantSelect },
        },
      },
    },
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  let reminded = 0;
  let notified = 0;
  let emailed = 0;

  for (const m of meetings) {
    // Guaranteed by the query above; the guard is what tells TypeScript so.
    if (!m.relation) continue;
    // Claim it first — see the idempotency note above.
    const claim = await prisma.meeting.updateMany({
      where: { id: m.id, reminderSentAt: null },
      data: { reminderSentAt: new Date() },
    });
    if (claim.count === 0) continue;
    reminded++;

    const minutes = Math.max(1, Math.round((m.scheduledAt!.getTime() - Date.now()) / 60000));

    // Both sides of the relation are participants. Series-generated meetings
    // (seriesId set) carry the same relation, so they need no special casing.
    const participants = [m.relation.mentee, m.relation.mentor].filter(
      (u, i, all) => u && all.findIndex((o) => o?.id === u.id) === i
    );

    for (const user of participants) {
      const link = user.role === 'MENTEE' ? '/portal' : '/mentor/meetings';
      // Per participant: the two sides of a relation can sit in different zones,
      // and each must read the time on their own clock (#1030).
      const when = formatInTimeZone(m.scheduledAt!, user.timezone);
      // In-app: unconditional (notify() never throws).
      await notify(
        user.id,
        'meeting_reminder',
        `Meeting "${m.title}" starts in ${minutes} minute${minutes === 1 ? '' : 's'} (${when}).`,
        link
      );
      notified++;

      if (!user.email || !emailAllowed(user, 'meetingReminders')) continue;
      try {
        const brand = await emailBrand(user.orgId);
        await sendEmail({
          to: user.email,
          fromName: brand.name,
          subject: `Reminder: ${m.title} starts soon`,
          html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${brandHeader(brand, 'Upcoming meeting')}
            <p>Hi ${esc(user.fullName ?? '')}, this is a reminder for <strong>${esc(m.title)}</strong>.</p>
            <p><strong>When:</strong> ${when} (in about ${minutes} minute${minutes === 1 ? '' : 's'})</p>
            ${m.meetLink ? `<p><strong>Meeting link:</strong> <a href="${m.meetLink}">${esc(m.meetLink)}</a></p>` : ''}
            ${ctaBlock(brand, `${appUrl}${link}`, 'Open the app')}
          </div>`,
        });
        emailed++;
      } catch (e) {
        // Swallowed on purpose: a bad address or an SMTP hiccup must not stop
        // the remaining participants (or meetings) from being reminded.
        console.error('Meeting reminder email failed:', e);
      }
    }
  }
  return { checked: meetings.length, reminded, notified, emailed };
}

// --- Recurring project meetings (#51) ---------------------------------------
//
// A project's weekly call belongs to the whole project, not to a mentorship: the
// people who should show up are its members (owner, mentors, mentee developers
// and testers alike), and most of them have no MentorshipRelation carrying the
// project. So these reminders are driven straight off the MeetingSeries rule
// instead of the per-relation `Meeting` rows, and their idempotency marker is a
// MeetingSeriesReminder row per (series, occurrence, lead time): the insert has
// to win before anything is sent, so an overlapping cron tick can't double-mail.
//
// Two lead times, because "the weekly meeting is tomorrow" and "it starts in an
// hour" are different reminders: DAY_BEFORE (~24h) and HOUR_BEFORE (~1h).
const SERIES_LOOKAHEAD_MINUTES = 25 * 60;

// Occurrences strictly after `from` and within the lookahead. The expansion
// itself lives in lib/meetingSeriesOccurrences so the reminder can never
// disagree with the calendar about what time the meeting is (#1110).
function upcomingSeriesOccurrences(
  series: { daysOfWeek: unknown; timeOfDay: string; timeZone: string | null },
  from: Date,
  withinMinutes: number
): Date[] {
  const horizon = new Date(from.getTime() + withinMinutes * 60 * 1000);
  return seriesOccurrences(series.daysOfWeek, series.timeOfDay, from, horizon, series.timeZone).filter(
    (when) => when > from
  );
}

function leadFor(minutesAway: number): 'DAY_BEFORE' | 'HOUR_BEFORE' | null {
  if (minutesAway <= 60) return 'HOUR_BEFORE';
  if (minutesAway >= 23 * 60) return 'DAY_BEFORE';
  return null;
}

export async function sendProjectMeetingSeriesReminders() {
  const now = new Date();
  const seriesList = await prisma.meetingSeries.findMany({
    where: { active: true, projectId: { not: null } },
    select: {
      id: true,
      title: true,
      daysOfWeek: true,
      timeOfDay: true,
      timeZone: true,
      fixedLink: true,
      projectId: true,
      project: { select: { id: true, name: true, orgId: true } },
    },
  });

  let reminded = 0;
  let notified = 0;
  let emailed = 0;

  for (const series of seriesList) {
    if (!series.projectId) continue;

    const occurrences = upcomingSeriesOccurrences(series, now, SERIES_LOOKAHEAD_MINUTES);
    if (occurrences.length === 0) continue;

    // The whole team, not just the ProjectMember rows: a mentee attached to the
    // project the legacy way (MentorshipRelation.projectId) is expected at the
    // same call, and since series meetings are now excluded from the
    // per-relation reminder they would otherwise be reminded by nobody.
    const team = await loadProjectTeam(series.projectId);
    if (team.length === 0) continue;
    const recipients = await prisma.user.findMany({
      where: { id: { in: team.map((m) => m.id) }, isActive: true },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        emailNotifications: true,
        notificationPrefs: true,
        timezone: true,
      },
    });
    if (recipients.length === 0) continue;

    for (const when of occurrences) {
      const lead = leadFor((when.getTime() - now.getTime()) / 60000);
      if (!lead) continue;

      // Claim first — see the idempotency note above.
      try {
        await prisma.meetingSeriesReminder.create({ data: { seriesId: series.id, occurrenceAt: when, lead } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
      reminded++;

      const projectName = series.project?.name ?? '';
      for (const user of recipients) {
        const link = `/projects/${series.projectId}`;
        const whenLocal = formatInTimeZone(when, user.timezone);
        await notify(
          user.id,
          'meeting_reminder',
          lead === 'HOUR_BEFORE'
            ? `"${series.title}" (${projectName}) starts soon — ${whenLocal}.`
            : `"${series.title}" (${projectName}) is tomorrow — ${whenLocal}.`,
          link
        );
        notified++;

        if (!user.email || !emailAllowed(user, 'meetingReminders')) continue;
        try {
          const brand = await emailBrand(series.project?.orgId ?? null);
          await sendEmail({
            to: user.email,
            fromName: brand.name,
            subject:
              lead === 'HOUR_BEFORE'
                ? `Reminder: ${series.title} starts soon`
                : `Tomorrow: ${series.title} (${projectName})`,
            html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              ${brandHeader(brand, 'Recurring project meeting')}
              <p>Hi ${esc(user.fullName ?? '')}, this is a reminder for <strong>${esc(series.title)}</strong>${projectName ? ` (${esc(projectName)})` : ''}.</p>
              <p><strong>When:</strong> ${whenLocal}</p>
              ${series.fixedLink ? `<p><strong>Meeting link:</strong> <a href="${series.fixedLink}">${esc(series.fixedLink)}</a></p>` : ''}
              ${ctaBlock(brand, `${appUrl()}${link}`, 'Open the project')}
            </div>`,
          });
          emailed++;
        } catch (e) {
          // One bad address must not cost the rest of the team their reminder.
          console.error('Project meeting reminder email failed:', e);
        }
      }
    }
  }

  return { series: seriesList.length, reminded, notified, emailed };
}

// Weekly per-mentor digest: stale mentees, upcoming meetings, new applications.
export async function sendWeeklyMentorDigests() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const mentors = await prisma.user.findMany({
    where: { role: 'MENTOR', isActive: true },
    select: {
      id: true,
      email: true,
      fullName: true,
      emailNotifications: true,
      notificationPrefs: true,
      mentorRelations: {
        select: {
          startDate: true,
          interactions: { orderBy: { date: 'desc' }, take: 1, select: { date: true } },
          meetings: { where: { scheduledAt: { gt: now, lte: in7d } }, select: { id: true } },
        },
      },
    },
  });

  let sent = 0;
  for (const m of mentors) {
    if (m.mentorRelations.length === 0) continue;
    if (!emailAllowed(m, 'digest')) continue;
    const stale = m.mentorRelations.filter(
      (r) => !r.interactions[0] || r.interactions[0].date < fourteenDaysAgo
    ).length;
    const upcoming = m.mentorRelations.reduce((n, r) => n + r.meetings.length, 0);
    const newApplications = m.mentorRelations.filter((r) => r.startDate >= weekAgo).length;

    try {
      await sendEmail({
        to: m.email,
        subject: 'Your weekly mentoring summary',
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color:#2563eb;">Weekly summary</h2>
          <p>Hi ${m.fullName}, here's your week at a glance:</p>
          <ul>
            <li><strong>${stale}</strong> mentee(s) with no interaction in 14+ days</li>
            <li><strong>${upcoming}</strong> meeting(s) coming up this week</li>
            <li><strong>${newApplications}</strong> new application(s) in the last 7 days</li>
          </ul>
          <a href="${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/mentor" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Open dashboard</a>
        </div>`,
      });
      sent++;
    } catch (e) {
      console.error('Mentor digest failed:', e);
    }
  }
  return { mentors: mentors.length, sent };
}

// Renders the per-mentee rows of the daily activity digest email. Page-view /
// time-on-site columns are only meaningful for mentees who opted into activity
// tracking; they simply read 0 for those who didn't.
function activityDigestTable(items: MenteeActivity[]): string {
  const rows = items
    .map((m) => {
      const login =
        m.daysSinceLogin === null
          ? 'never'
          : m.daysSinceLogin <= 0
            ? 'today'
            : `${m.daysSinceLogin}d ago`;
      const flag = m.daysSinceLogin !== null && m.daysSinceLogin >= 7 ? ' ⚠️' : '';
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.menteeName}${flag}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${login}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${formatDuration(m.timeOnSiteSec)} · ${m.pageViews}p</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.goalsCompleted}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.interactions}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.meetings}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.pipelineChanges}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.messagesSent}/${m.messagesReceived}</td>
      </tr>`;
    })
    .join('');
  return `<table style="border-collapse:collapse;width:100%;font-size:13px;">
    <thead><tr style="text-align:left;color:#6b7280;">
      <th style="padding:6px 8px;">Mentee</th><th style="padding:6px 8px;">Login</th>
      <th style="padding:6px 8px;">On site</th><th style="padding:6px 8px;">Goals</th>
      <th style="padding:6px 8px;">Interac.</th><th style="padding:6px 8px;">Meet.</th>
      <th style="padding:6px 8px;">Stage</th><th style="padding:6px 8px;">Msg s/r</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// Daily mentee-activity digest. Each mentor gets a summary of THEIR mentees'
// activity in the last 24h; each admin gets a system-wide summary. Respects the
// 'digest' email preference. Recipients with no mentees / no data are skipped.
export async function sendDailyActivityDigests() {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  let sent = 0;

  const mentors = await prisma.user.findMany({
    where: { role: 'MENTOR', isActive: true },
    select: { id: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true },
  });
  for (const m of mentors) {
    if (!emailAllowed(m, 'digest')) continue;
    const items = await getMentorMenteeActivity(m.id, since);
    if (items.length === 0) continue;
    try {
      await sendEmail({
        to: m.email,
        subject: 'Daily mentee activity',
        html: `<div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
          <h2 style="color:#2563eb;">Daily mentee activity</h2>
          <p>Hi ${m.fullName}, here's what your mentees did in the last 24 hours:</p>
          ${activityDigestTable(items)}
          <p style="margin-top:16px;"><a href="${appUrl}/mentor/mentee-activity" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Open full report</a></p>
          <p style="color:#9ca3af;font-size:12px;">Time-on-site and page views are shown only for mentees who enabled activity tracking.</p>
        </div>`,
      });
      sent++;
    } catch (e) {
      console.error('Mentor activity digest failed:', e);
    }
  }

  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true },
  });
  const adminItems = await getSystemMenteeActivity(since);
  if (adminItems.length > 0) {
    for (const a of admins) {
      if (!emailAllowed(a, 'digest')) continue;
      try {
        await sendEmail({
          to: a.email,
          subject: 'Daily mentee activity (all mentees)',
          html: `<div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
            <h2 style="color:#2563eb;">Daily mentee activity</h2>
            <p>Hi ${a.fullName}, system-wide mentee activity in the last 24 hours:</p>
            ${activityDigestTable(adminItems)}
            <p style="margin-top:16px;"><a href="${appUrl}/admin/mentee-activity" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Open full report</a></p>
          </div>`,
        });
        sent++;
      } catch (e) {
        console.error('Admin activity digest failed:', e);
      }
    }
  }

  return { mentors: mentors.length, admins: admins.length, sent };
}

// Retention re-consent (GDPR Art. 5(1)(e) + 7): when a candidate's consent is
// older than the retention limit, email them a renewal link, notify them and
// admins in-app, and stamp the send so it isn't repeated. If they don't renew
// within the grace period they surface in the admin retention review for manual
// erasure — nothing is deleted automatically.
export async function checkRetentionReminders() {
  const months = await getRetentionMonths();
  const dueCutoff = new Date();
  dueCutoff.setMonth(dueCutoff.getMonth() - months);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const users = await prisma.user.findMany({
    where: {
      role: 'MENTEE',
      consentAt: { not: null, lt: dueCutoff },
      retentionReminderSentAt: null,
    },
    select: { id: true, fullName: true, email: true },
  });

  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true },
  });

  let reminded = 0;
  for (const u of users) {
    const renewUrl = `${appUrl}/consent/renew?token=${makeConsentRenewToken(u.id)}`;
    // Legal/retention notice — always sent (not gated by marketing opt-out).
    try {
      await sendEmail({
        to: u.email,
        subject: 'Please confirm you still want us to keep your data',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color:#2563eb;">Do you want to keep your data with us?</h2>
            <p>Hi ${u.fullName},</p>
            <p>It has been more than ${months} months since you agreed to us storing your
            data (profile, CV and interaction history). To keep it, please confirm below.
            If you don't, an administrator will review your record for deletion.</p>
            <a href="${renewUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;margin:16px 0;">Keep my data</a>
            <p style="color:#6b7280;font-size:12px;">You can also download or delete your data anytime from Account settings.</p>
          </div>`,
      });
    } catch (e) {
      console.error('checkRetentionReminders email failed:', { userId: u.id, error: e });
    }
    await notify(u.id, 'retention', 'Please confirm you still want us to keep your data.', `/consent/renew?token=${makeConsentRenewToken(u.id)}`);
    await prisma.user.update({ where: { id: u.id }, data: { retentionReminderSentAt: new Date() } });
    reminded += 1;
  }

  // Let admins know how many candidates are up for retention review.
  if (reminded > 0) {
    await Promise.all(
      admins.map((a) => notify(a.id, 'retention', `${reminded} candidate(s) asked to re-consent (data retention).`, '/admin/retention'))
    );
  }

  return { checked: users.length, reminded, retentionMonths: months, graceDays: RETENTION_GRACE_DAYS };
}

// Does a consenting candidate match any of a company's open positions? A match
// is a loose, case-insensitive overlap between a need's position and the
// candidate's target position or one of their skills — deliberately generous
// (the alert is a "worth a look" nudge, not a hard filter).
function candidateMatchesNeeds(
  positions: string[],
  cand: { targetPosition?: string | null; skills: unknown }
): boolean {
  const target = (cand.targetPosition || '').toLowerCase().trim();
  const skills = (Array.isArray(cand.skills) ? cand.skills : []).map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  return positions.some((pos) => {
    if (!pos) return false;
    if (target && (target.includes(pos) || pos.includes(target))) return true;
    return skills.some((sk) => sk && (pos.includes(sk) || sk.includes(pos)));
  });
}

// Premium CompanyNeed match alerts (Faz 1, #530). For every company holding the
// COMPANY_NEED_MATCH_ALERTS entitlement, scan the consenting talent pool (the
// same publicProfile-only visibility as talent-pool search) for candidates
// matching an open position, and notify the company's users once per candidate.
// Repeat notifications are prevented by the CompanyNeedAlert dedupe row (the
// unique [companyId, menteeId] insert is the marker — createMany/skipDuplicates
// makes "insert-or-skip" atomic, so a candidate only ever alerts a company once).
export async function checkCompanyNeedMatches() {
  const companies = await prisma.company.findMany({
    where: {
      entitlements: { some: { feature: 'COMPANY_NEED_MATCH_ALERTS' } },
      needs: { some: {} },
    },
    select: {
      id: true,
      name: true,
      needs: { select: { position: true } },
      users: {
        where: { role: 'COMPANY', isActive: true },
        select: { id: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true },
      },
    },
  });
  if (companies.length === 0) return { companies: 0, alerts: 0 };

  // The consenting talent pool — publicProfile opt-in AND an active
  // TALENT_POOL_VISIBILITY consent (#527), same visibility rule as talent-pool
  // search.
  const pool = await prisma.user.findMany({
    where: {
      role: 'MENTEE',
      isActive: true,
      publicProfile: true,
      consents: { some: { type: 'TALENT_POOL_VISIBILITY', grantedAt: { not: null }, revokedAt: null } },
    },
    select: { id: true, fullName: true, targetPosition: true, skills: true },
  });
  if (pool.length === 0) return { companies: companies.length, alerts: 0 };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  let alerts = 0;

  for (const company of companies) {
    const positions = company.needs.map((n) => n.position.toLowerCase().trim()).filter(Boolean);
    if (positions.length === 0) continue;

    for (const cand of pool) {
      if (!candidateMatchesNeeds(positions, cand)) continue;

      // Atomic dedupe: the insert succeeds only the first time; count 0 means
      // this company was already alerted about this candidate — skip silently.
      const created = await prisma.companyNeedAlert.createMany({
        data: [{ companyId: company.id, menteeId: cand.id }],
        skipDuplicates: true,
      });
      if (created.count === 0) continue;

      alerts += 1;
      const link = `/p/${cand.id}`;
      const text = `New candidate matches your open position: ${cand.fullName}`;
      for (const u of company.users) {
        await notify(u.id, 'need_match', text, link);
        if (emailAllowed(u, 'digest')) {
          await sendEmail({
            to: u.email,
            subject: 'A candidate matches your open position',
            html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color:#2563eb;">New matching candidate</h2>
              <p>Hi ${u.fullName},</p>
              <p><strong>${cand.fullName}</strong> matches one of ${company.name}'s open positions${cand.targetPosition ? ` (${cand.targetPosition})` : ''}.</p>
              <p><a href="${appUrl}${link}">View profile</a></p>
            </div>`,
          }).catch((error) => {
            console.error('checkCompanyNeedMatches email failed:', { companyId: company.id, userId: u.id, error });
          });
        }
      }
    }
  }

  return { companies: companies.length, alerts };
}

// Weekly scheduled analytics report email (Faz 2, #541). Premium: only runs
// when the premiumAnalytics setting is on. Sends every active admin a compact
// pipeline summary — total relations, hired conversion, stage counts and the
// last 7 days' activity — honoring the per-user digest email opt-out.
export async function sendWeeklyAnalyticsReport() {
  if ((await getSetting('premiumAnalytics')) !== 'true') return { locked: true, sent: 0 };

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [byStage, newRelations, interactions, admins] = await Promise.all([
    prisma.mentorshipRelation.groupBy({ by: ['pipelineStatus'], _count: { _all: true } }),
    prisma.mentorshipRelation.count({ where: { startDate: { gte: weekAgo } } }),
    prisma.interactionLog.count({ where: { date: { gte: weekAgo } } }),
    prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true },
      select: { id: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true },
    }),
  ]);

  const total = byStage.reduce((n, s) => n + s._count._all, 0);
  const hired = byStage
    .filter((s) => s.pipelineStatus === 'HIRED_660' || s.pipelineStatus === 'EMPLOYED_700')
    .reduce((n, s) => n + s._count._all, 0);
  const conversion = total ? Math.round((hired / total) * 100) : 0;
  const stageRows = byStage
    .sort((a, b) => b._count._all - a._count._all)
    .map((s) => `<tr><td style="padding:4px 12px 4px 0;">${s.pipelineStatus}</td><td style="padding:4px 0;"><strong>${s._count._all}</strong></td></tr>`) // eslint-disable-line
    .join('');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  let sent = 0;
  for (const a of admins) {
    if (!emailAllowed(a, 'digest')) continue;
    await sendEmail({
      to: a.email,
      subject: 'Weekly analytics report — Internship CRM',
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color:#2563eb;">Weekly analytics report</h2>
        <p>Hi ${a.fullName},</p>
        <p><strong>${total}</strong> mentorship relations · <strong>${conversion}%</strong> hired conversion ·
        last 7 days: <strong>${newRelations}</strong> new relations, <strong>${interactions}</strong> interactions.</p>
        <table style="font-size:14px;border-collapse:collapse;">${stageRows}</table>
        <p><a href="${appUrl}/admin/analytics">Open the analytics dashboard</a></p>
      </div>`,
    }).catch((error) => {
      console.error('sendWeeklyAnalyticsReport email failed:', { userId: a.id, error });
    });
    sent++;
  }
  return { locked: false, sent };
}

// Unread-message digest (#667): once an hour, gather messages that have been
// unread for over UNREAD_DIGEST_AFTER_MIN minutes and not yet digested, group by
// recipient, and send ONE summary email (opt-in). Complements the instant in-app
// notification without spamming per message. Idempotent via Message.digestedAt,
// so a message is never included in more than one digest.
const UNREAD_DIGEST_AFTER_MIN = 60;

export async function sendUnreadMessageDigests() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - UNREAD_DIGEST_AFTER_MIN * 60 * 1000);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const userSelect = { id: true, fullName: true, email: true, emailNotifications: true, notificationPrefs: true } as const;
  const msgs = await prisma.message.findMany({
    // relationId is nullable since #768; the digest covers mentorship threads
    // only, so conversation-only messages are skipped (and left un-digested for
    // the conversation-layer digest to pick up later).
    where: { readAt: null, digestedAt: null, deletedForEveryoneAt: null, createdAt: { lt: cutoff }, relationId: { not: null } },
    orderBy: { createdAt: 'asc' },
    include: {
      relation: { include: { mentor: { select: userSelect }, mentee: { select: userSelect } } },
    },
  });

  // Group unread messages by recipient (the participant who is NOT the sender).
  type Recipient = NonNullable<(typeof msgs)[number]['relation']>['mentor'];
  const byRecipient = new Map<string, { recipient: Recipient; items: { relationId: string; from: string; preview: string }[] }>();
  const allIds: string[] = [];
  for (const m of msgs) {
    const rel = m.relation;
    // Defensive: the query filters relationId out, so this cannot normally fire.
    if (!rel) continue;
    allIds.push(m.id);
    const recipient = m.senderId === rel.mentorId ? rel.mentee : rel.mentor;
    const sender = m.senderId === rel.mentorId ? rel.mentor : rel.mentee;
    if (!recipient?.email) continue;
    const entry = byRecipient.get(recipient.id) ?? { recipient, items: [] };
    entry.items.push({ relationId: rel.id, from: sender?.fullName ?? 'Someone', preview: m.body.slice(0, 120) });
    byRecipient.set(recipient.id, entry);
  }

  let sent = 0;
  for (const { recipient, items } of byRecipient.values()) {
    if (!emailAllowed(recipient, 'messages')) continue;
    const rows = items
      .map((it) => {
        const safe = it.preview.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
        return `<li style="margin-bottom:8px;"><strong>${it.from}:</strong> ${safe || '(attachment)'} — <a href="${appUrl}/messages/${it.relationId}">Open</a></li>`;
      })
      .join('');
    try {
      await sendEmail({
        to: recipient.email!,
        subject: `You have ${items.length} unread message${items.length === 1 ? '' : 's'}`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
          <h2 style="color:#2563eb;">Unread messages</h2>
          <p>Hi ${recipient.fullName}, you have ${items.length} unread message${items.length === 1 ? '' : 's'} waiting:</p>
          <ul style="padding-left:18px;">${rows}</ul>
        </div>`,
      });
      sent++;
    } catch (e) {
      console.error('Unread message digest failed:', e);
    }
  }

  // Mark every considered message as digested (even for opted-out recipients) so
  // the cron never reprocesses them.
  if (allIds.length) {
    await prisma.message.updateMany({ where: { id: { in: allIds } }, data: { digestedAt: now } });
  }
  return { sent, considered: allIds.length };
}

const scheduledTasks = new Map<string, ReturnType<typeof cron.schedule>>();

export function initCronJobs() {
  if (scheduledTasks.has('mentor-reminders')) return;

  // Run every day at 9:00 AM
  const task = cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Running mentor interaction reminder check...');
    try {
      const result = await checkMentorInteractionReminders();
      console.log(`[Cron] Done. Checked: ${result.checked}, Reminded: ${result.reminded}`);
      const dl = await checkStageDeadlineReminders();
      console.log(`[Cron] Stage deadline reminders: ${dl.reminded}`);
      const rr = await checkRetentionReminders();
      console.log(`[Cron] Retention re-consent reminders: ${rr.reminded}`);
      const nm = await checkCompanyNeedMatches();
      console.log(`[Cron] Company need-match alerts: ${nm.alerts}`);
    } catch (error) {
      console.error('[Cron] Error running reminder check:', error);
    }
  });

  scheduledTasks.set('mentor-reminders', task);

  // Meeting reminders — every 15 minutes. The reminder window is 60 minutes
  // (MEETING_REMINDER_WINDOW_MINUTES); an hourly tick would fire anywhere from
  // 0 to 60 minutes ahead, so a quarter-hourly tick is what actually delivers
  // "about an hour before" (45-60 min). reminderSentAt keeps it single-shot.
  const meetingTask = cron.schedule('*/15 * * * *', async () => {
    try {
      const r = await sendMeetingReminders();
      if (r.reminded) {
        console.log(`[Cron] Meeting reminders. Reminded: ${r.reminded}, in-app: ${r.notified}, emails: ${r.emailed}`);
      }
      // Recurring project meetings ride the same tick: their windows are 1h/24h
      // wide, so a quarter-hourly check is what makes "an hour before" accurate.
      const s = await sendProjectMeetingSeriesReminders();
      if (s.reminded) {
        console.log(`[Cron] Project meeting reminders. Occurrences: ${s.reminded}, in-app: ${s.notified}, emails: ${s.emailed}`);
      }
    } catch (e) {
      console.error('[Cron] Meeting reminder error:', e);
    }
  });
  scheduledTasks.set('meeting-reminders', meetingTask);

  // Weekly mentor digest — Mondays 8:00.
  const digestTask = cron.schedule('0 8 * * 1', async () => {
    try {
      const r = await sendWeeklyMentorDigests();
      console.log(`[Cron] Weekly digests sent: ${r.sent}`);
    } catch (e) {
      console.error('[Cron] Digest error:', e);
    }
  });
  scheduledTasks.set('weekly-digest', digestTask);

  // Weekly premium analytics report — Mondays 8:15 (no-op while the
  // premiumAnalytics setting is off).
  const analyticsTask = cron.schedule('15 8 * * 1', async () => {
    try {
      const r = await sendWeeklyAnalyticsReport();
      if (!r.locked) console.log(`[Cron] Weekly analytics reports sent: ${r.sent}`);
    } catch (e) {
      console.error('[Cron] Analytics report error:', e);
    }
  });
  scheduledTasks.set('analytics-report', analyticsTask);

  // Daily mentee-activity digest — every day at 7:30.
  const activityTask = cron.schedule('30 7 * * *', async () => {
    try {
      const r = await sendDailyActivityDigests();
      console.log(`[Cron] Daily activity digests sent: ${r.sent}`);
    } catch (e) {
      console.error('[Cron] Activity digest error:', e);
    }
  });
  scheduledTasks.set('activity-digest', activityTask);

  // Unread-message digest — hourly at :20 (offset from the other hourly jobs).
  const unreadDigestTask = cron.schedule('20 * * * *', async () => {
    try {
      const r = await sendUnreadMessageDigests();
      if (r.sent) console.log(`[Cron] Unread message digests sent: ${r.sent}`);
    } catch (e) {
      console.error('[Cron] Unread message digest error:', e);
    }
  });
  scheduledTasks.set('unread-message-digest', unreadDigestTask);

  console.log('[Cron] Scheduled jobs initialized');
}
