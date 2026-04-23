import nodemailer from 'nodemailer';
import cron from 'node-cron';
import { prisma } from '@/lib/prisma';

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
}: {
  to: string;
  subject: string;
  html: string;
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

export async function checkMentorInteractionReminders() {
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

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

const scheduledTasks = new Map<string, ReturnType<typeof cron.schedule>>();

export function initCronJobs() {
  if (scheduledTasks.has('mentor-reminders')) return;

  // Run every day at 9:00 AM
  const task = cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Running mentor interaction reminder check...');
    try {
      const result = await checkMentorInteractionReminders();
      console.log(`[Cron] Done. Checked: ${result.checked}, Reminded: ${result.reminded}`);
    } catch (error) {
      console.error('[Cron] Error running reminder check:', error);
    }
  });

  scheduledTasks.set('mentor-reminders', task);
  console.log('[Cron] Scheduled jobs initialized');
}
