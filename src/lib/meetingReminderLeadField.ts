// The zod field for a meeting's own reminder lead (#1636), shared by the create
// and edit routes. null/omitted = the programme default; 0 = no reminder.
import { z } from 'zod';
import { MAX_LEAD_MINUTES } from './meetingReminderLeads';

export const reminderLeadField = z.number().int().min(0).max(MAX_LEAD_MINUTES).nullable().optional();
