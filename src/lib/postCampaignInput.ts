import { z } from 'zod';
import { CAMPAIGN_CODE_RE } from '@/lib/postCampaignRule';

// The editable fields of a postal campaign (#2697), shared by create and edit.
// The data source and the balancing note are required and not trivially short:
// they ARE the Art. 14 Abs. 2 lit. f answer printed on every letter and the
// Art. 6 Abs. 1 lit. f record — a placeholder is not either.
export const campaignFields = {
  name: z.string().trim().min(3).max(120),
  dataSource: z.string().trim().min(10).max(2000),
  balancingNote: z.string().trim().min(20).max(4000),
  letterBody: z.string().trim().min(20).max(6000),
};

export const campaignCreateSchema = z.object({
  ...campaignFields,
  code: z.string().trim().toLowerCase().regex(CAMPAIGN_CODE_RE).optional(),
});

export const campaignUpdateSchema = z.object(campaignFields).partial();
