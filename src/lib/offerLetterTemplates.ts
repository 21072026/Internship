// The built-in offer letter per locale (#1857): what an org that defined
// nothing gets — the "define nothing, keep the built-in" convention of
// EvaluationTemplate and the pipeline stages. Merge tags: src/lib/offerLetter.ts.

import type { Locale } from '@/i18n/config';

export const BUILT_IN_OFFER_LETTERS: Record<Locale, string> = {
  en: `# Offer of employment

Dear {{candidateName}},

On behalf of {{companyName}} and {{programName}}, we are pleased to offer you the position of **{{position}}**.

## The offer

- Position: {{position}}
- Start date: {{startDate}}
- Compensation: {{compensation}}

Please let us know your decision by {{expiresAt}}.

We look forward to working with you.

{{programName}}`,
  tr: `# İş teklifi

Sayın {{candidateName}},

{{companyName}} ve {{programName}} adına size **{{position}}** pozisyonunu teklif etmekten memnuniyet duyuyoruz.

## Teklif

- Pozisyon: {{position}}
- Başlangıç tarihi: {{startDate}}
- Ücret: {{compensation}}

Lütfen kararınızı {{expiresAt}} tarihine kadar bize bildirin.

Sizinle çalışmayı dört gözle bekliyoruz.

{{programName}}`,
  de: `# Stellenangebot

Liebe/r {{candidateName}},

im Namen von {{companyName}} und {{programName}} freuen wir uns, Ihnen die Position **{{position}}** anzubieten.

## Das Angebot

- Position: {{position}}
- Startdatum: {{startDate}}
- Vergütung: {{compensation}}

Bitte teilen Sie uns Ihre Entscheidung bis zum {{expiresAt}} mit.

Wir freuen uns auf die Zusammenarbeit.

{{programName}}`,
};
