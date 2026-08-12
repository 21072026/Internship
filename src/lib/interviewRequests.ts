import { z } from 'zod';

export const INTERVIEW_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'DECLINED', 'SCHEDULED', 'CANCELLED'] as const;

export const createInterviewRequestSchema = z.object({
  requisitionId: z.string().min(1),
  menteeId: z.string().min(1),
  note: z.string().trim().max(1000).nullable().optional(),
  proposedSlots: z.array(z.string().datetime({ offset: true })).max(5).optional(),
}).strict();

export const decideInterviewRequestSchema = z.object({
  action: z.enum(['approve', 'decline']),
  note: z.string().trim().max(1000).nullable().optional(),
}).strict();

export function interviewActiveKey(requisitionId: string, menteeId: string) {
  return `${requisitionId}:${menteeId}`;
}
