import nodemailer from 'nodemailer';
import cron from 'node-cron';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { getSetting } from '@/lib/settings';
import { emailAllowed } from '@/lib/notificationPrefs';
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

export async function sendEmail({
  to,
  subject,
  html,
  replyTo,
}: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}) {
  if (!process.env.SMTP_USER) {
    console.log(`[Email skipped - no SMTP config] To: ${to}, Subject: ${subject}`);
    return;
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  });
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
  scheduledAt: Date;
  meetLink?: string | null;
  rsvpToken: string;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const yes = `${appUrl}/rsvp/${rsvpToken}?r=yes`;
  const no = `${appUrl}/rsvp/${rsvpToken}?r=no`;
  const when = scheduledAt.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });

  await sendEmail({
    to,
    subject: `Meeting invitation: ${title}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">${title}</h2>
        ${fullName ? `<p>Hi ${fullName},</p>` : ''}
        <p>You're invited to a meeting.</p>
        <p><strong>When:</strong> ${when}</p>
        ${meetLink ? `<p><strong>Google Meet:</strong> <a href="${meetLink}">${meetLink}</a></p>` : ''}
        <p style="margin-top: 20px;">Can you make it?</p>
        <a href="${yes}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;margin-right:8px;">Yes, I'll attend</a>
        <a href="${no}" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Can't attend</a>
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
    if (!lastInteraction || lastInteraction.date < fourteenDaysAgo) {
      remindersToSend.push(relation);
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
          <p>Hi ${m.relation.mentee.fullName}, this is a reminder for <strong>${m.title}</strong> at ${m.scheduledAt.toLocaleString('en-GB')}.</p>
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

  console.log('[Cron] Scheduled jobs initialized');
}
