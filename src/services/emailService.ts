import nodemailer from 'nodemailer';
import cron from 'node-cron';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { getSetting } from '@/lib/settings';
import { emailAllowed } from '@/lib/notificationPrefs';
import { makeConsentRenewToken } from '@/lib/consentRenew';
import { getRetentionMonths, RETENTION_GRACE_DAYS } from '@/lib/retention';
import { getMentorMenteeActivity, getSystemMenteeActivity, formatDuration, type MenteeActivity } from '@/lib/activityReport';
import type { PipelineStatus } from '@prisma/client';

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
function fromHeader(): string {
  const addr = process.env.SMTP_FROM || process.env.SMTP_USER || '';
  if (addr.includes('<') || !addr) return addr;
  const name = process.env.MAIL_FROM_NAME || 'Internship CRM';
  return `${name} <${addr}>`;
}

export async function sendEmail({
  to,
  subject,
  html,
  replyTo,
  attachments,
}: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}) {
  if (!process.env.SMTP_USER) {
    console.log(`[Email skipped - no SMTP config] To: ${to}, Subject: ${subject}`);
    return;
  }

  await transporter.sendMail({
    from: fromHeader(),
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
}: {
  to: string;
  token: string;
  role: string;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const registerUrl = `${appUrl}/auth/register?token=${token}`;

  await sendEmail({
    to,
    subject: 'You have been invited to Internship CRM',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Welcome to Internship CRM</h2>
        <p>You have been invited to join as a <strong>${role}</strong>.</p>
        <p>Click the button below to complete your registration:</p>
        <a href="${registerUrl}" style="
          display: inline-block;
          background-color: #2563eb;
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
}: {
  to: string;
  token: string;
  fullName?: string | null;
  purpose?: 'RESET' | 'SET_INITIAL';
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const resetUrl = `${appUrl}/auth/reset?token=${token}`;
  const isInitial = purpose === 'SET_INITIAL';

  const heading = isInitial ? 'Set your password' : 'Reset your password';
  const intro = isInitial
    ? 'An account has been created for you on Internship CRM. Set a password to activate it and sign in.'
    : 'We received a request to reset your password. Click the button below to choose a new one.';
  const cta = isInitial ? 'Set password' : 'Reset password';

  await sendEmail({
    to,
    subject: isInitial ? 'Activate your Internship CRM account' : 'Reset your Internship CRM password',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">${heading}</h2>
        ${fullName ? `<p>Hi ${fullName},</p>` : ''}
        <p>${intro}</p>
        <a href="${resetUrl}" style="
          display: inline-block;
          background-color: #2563eb;
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
}: {
  to: string;
  token: string;
  fullName?: string | null;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const verifyUrl = `${appUrl}/auth/verify?token=${token}`;

  await sendEmail({
    to,
    subject: 'Verify your Internship CRM email',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Confirm your email</h2>
        ${fullName ? `<p>Hi ${fullName},</p>` : ''}
        <p>Please confirm your email address to activate full access to your account.</p>
        <a href="${verifyUrl}" style="
          display: inline-block;
          background-color: #2563eb;
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
}: {
  to: string;
  fullName?: string | null;
  title: string;
  scheduledAt: Date | null;
  meetLink?: string | null;
  rsvpToken: string;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const yes = `${appUrl}/rsvp/${rsvpToken}?r=yes`;
  const no = `${appUrl}/rsvp/${rsvpToken}?r=no`;
  // A meeting with no set time is just a shared link — skip the "when" line and
  // the RSVP ask entirely.
  const when = scheduledAt ? scheduledAt.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' }) : null;

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
        ${when ? `
        <p style="margin-top: 20px;">Can you make it?</p>
        <a href="${yes}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;margin-right:8px;">Yes, I'll attend</a>
        <a href="${no}" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Can't attend</a>
        ` : ''}
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

  for (const relation of remindersToSend) {
    const lastDate = relation.interactions[0]?.date;
    const daysSince = lastDate
      ? Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    await sendEmail({
      to: relation.mentor.email,
      subject: `Reminder: Log interaction with ${relation.mentee.fullName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">Interaction Reminder</h2>
          <p>Hi ${relation.mentor.fullName},</p>
          <p>
            ${
              daysSince
                ? `It has been <strong>${daysSince} days</strong> since you last logged an interaction`
                : 'You have not yet logged any interactions'
            }
            with your mentee <strong>${relation.mentee.fullName}</strong>.
          </p>
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
  }

  return {
    checked: activeRelations.length,
    reminded: remindersToSend.length,
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
      pipelineStatus: { notIn: TERMINAL as unknown as PipelineStatus[] },
    },
    include: { mentor: true, mentee: true },
  });

  for (const rel of overdue) {
    await notify(rel.mentorId, 'deadline', `Stage deadline passed for ${rel.mentee.fullName}.`, `/admin/candidates/${rel.menteeId}`);
    if (emailAllowed(rel.mentor, 'deadlines')) {
      await sendEmail({
        to: rel.mentor.email,
        subject: `Overdue: ${rel.mentee.fullName}'s stage deadline`,
        html: `<p>Hi ${rel.mentor.fullName},</p><p>The stage deadline for <strong>${rel.mentee.fullName}</strong> has passed. Please review their progress.</p>`,
      }).catch(() => {});
    }
    await prisma.mentorshipRelation.update({ where: { id: rel.id }, data: { deadlineReminderSentAt: now } });
  }

  return { reminded: overdue.length };
}

// Email reminders for meetings happening within the next 24h that haven't been
// reminded yet.
export async function sendMeetingReminders() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const meetings = await prisma.meeting.findMany({
    where: { scheduledAt: { gt: now, lte: in24h }, reminderSentAt: null },
    include: { relation: { include: { mentee: { select: { email: true, fullName: true } } } } },
  });

  let reminded = 0;
  for (const m of meetings) {
    try {
      await sendEmail({
        to: m.relation.mentee.email,
        subject: `Reminder: ${m.title}`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color:#2563eb;">Upcoming meeting</h2>
          <p>Hi ${m.relation.mentee.fullName}, this is a reminder for <strong>${m.title}</strong> at ${m.scheduledAt!.toLocaleString('en-GB')}.</p>
          ${m.meetLink ? `<p><a href="${m.meetLink}">${m.meetLink}</a></p>` : ''}
        </div>`,
      });
    } catch (e) {
      console.error('Meeting reminder failed:', e);
    }
    await prisma.meeting.update({ where: { id: m.id }, data: { reminderSentAt: new Date() } });
    reminded++;
  }
  return { checked: meetings.length, reminded };
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
          }).catch(() => {});
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
    }).catch(() => {});
    sent++;
  }
  return { locked: false, sent };
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

  // Meeting reminders — hourly.
  const meetingTask = cron.schedule('0 * * * *', async () => {
    try {
      const r = await sendMeetingReminders();
      console.log(`[Cron] Meeting reminders. Reminded: ${r.reminded}`);
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

  console.log('[Cron] Scheduled jobs initialized');
}
