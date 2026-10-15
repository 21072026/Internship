import { z } from 'zod';
import { CAMPAIGN_CODE_RE } from '@/lib/postCampaignRule';
import { LETTER_BODY_MAX, LETTER_BODY_MIN } from '@/lib/postCampaignTemplates';

// The editable fields of a postal campaign (#2697), shared by create and edit.
// The data source and the balancing note are required and not trivially short:
// they ARE the Art. 14 Abs. 2 lit. f answer printed on every letter and the
// Art. 6 Abs. 1 lit. f record — a placeholder is not either.
export const campaignFields = {
  name: z.string().trim().min(3).max(120),
  dataSource: z.string().trim().min(10).max(2000),
  balancingNote: z.string().trim().min(20).max(4000),
  letterBody: z.string().trim().min(LETTER_BODY_MIN).max(LETTER_BODY_MAX),
};

// The organization's own default letter (#2927): the same bounds as a
// campaign's letter, or `''` to go back to the built-in one.
export const letterTemplateSchema = z.object({
  letterBody: z.string().trim().max(LETTER_BODY_MAX).refine((v) => v === '' || v.length >= LETTER_BODY_MIN),
});

export const campaignCreateSchema = z.object({
  ...campaignFields,
  code: z.string().trim().toLowerCase().regex(CAMPAIGN_CODE_RE).optional(),
});

export const campaignUpdateSchema = z.object(campaignFields).partial();
