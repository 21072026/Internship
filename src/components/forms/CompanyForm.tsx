'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { EnrichPanel } from '@/components/ai/EnrichPanel';
import type { ClientDictionary } from '@/i18n/dictionaries';
import { useVertical } from '@/lib/verticalClient';
import { verticalHasCapability } from '@/lib/verticals';

// Optional free-text field. Prisma returns `null` for empty nullable columns,
// so when editing an existing company those nulls reach the form. Plain
// `.optional()` only accepts `undefined` and rejected `null` with
// "Expected string, received null" (#569). Accept `undefined`/`null` and
// normalize to '' so validation passes AND the API always receives a string.
const optionalText = z.string().nullish().transform((v) => v ?? '');

// The schema is built per render because the length messages are translated —
// a cap the user can hit has to explain itself in their own language (#1433).
// Every text field here writes a VARCHAR column, and an uncapped one meant a
// 250-character paste passed the form, passed the API and died as a Prisma
// P2000, which reached the admin as "Internal server error".
//
// NO `maxLength` ON THESE INPUTS, deliberately. The browser enforces
// `maxLength` silently on paste: a 250-character legal entity name would be
// clipped to 191, sail through `.max()` and be saved 59 characters short with
// nothing shown. The cap has to be reported, not applied behind the user's
// back, so the bound lives only in zod and surfaces on the field. (The
// description box is a `<Textarea showCounter>`, where the hard stop *is*
// visible.)
function buildCompanySchema(t: ClientDictionary) {
  const tooLong = (max: number) => t.companyForm.tooLong.replace('{max}', String(max));
  /** An optional free-text column: normalize null → '' first, then bound it. */
  const boundedOptional = (max: number) => optionalText.pipe(z.string().max(max, tooLong(max)));
  /**
   * Same, for the two fields that are also format-checked. The length check is
   * a SEPARATE `.pipe()` stage ahead of the `x.or(z.literal(''))` union on
   * purpose: inside the union, an over-long value fails every branch and zod
   * reports the union's own "Invalid input" instead of the message that says
   * what is actually wrong.
   */
  const boundedFormat = (max: number, format: z.ZodType<string, z.ZodTypeDef, string>) =>
    optionalText.pipe(z.string().max(max, tooLong(max))).pipe(format.or(z.literal('')));
  return z.object({
    name: z
      .string()
      .min(1, 'Company name is required')
      .max(TEXT_LIMITS.companyName, tooLong(TEXT_LIMITS.companyName)),
    description: optionalText,
    contactEmail: boundedFormat(TEXT_LIMITS.companyContactEmail, z.string().email('Invalid email')),
    industry: boundedOptional(TEXT_LIMITS.companyIndustry),
    logoUrl: boundedFormat(TEXT_LIMITS.companyLogoUrl, z.string().url('Enter a valid URL')),
    size: boundedOptional(TEXT_LIMITS.companySize),
    address: boundedOptional(TEXT_LIMITS.companyAddress),
    quota: z.coerce.number().int().min(0).nullish(),
  });
}

type CompanySchema = ReturnType<typeof buildCompanySchema>;
type CompanyFormData = z.infer<CompanySchema>;

interface CompanyFormProps {
  defaultValues?: Partial<CompanyFormData>;
  onSubmit: (data: CompanyFormData) => Promise<void>;
  onCancel: () => void;
  isEditing?: boolean;
  /** The company being edited — scopes the "manage open positions" link. */
  companyId?: string;
}

export function CompanyForm({ defaultValues, onSubmit, onCancel, isEditing, companyId }: CompanyFormProps) {
  const t = useT();
  // The requisitions screen is a `placements` page; a vertical without the
  // module (MARKETING) gets no positions section at all rather than a link
  // into a closed page.
  const hasPositions = verticalHasCapability(useVertical(), 'placements');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const companySchema = useMemo(() => buildCompanySchema(t), [t]);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<CompanyFormData>({
    resolver: zodResolver(companySchema),
    defaultValues: defaultValues || {},
  });

  const handleFormSubmit = handleSubmit(async (data) => {
    setLoading(true);
    setError('');
    try {
      await onSubmit(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  });

  return (
    <form onSubmit={handleFormSubmit} className="space-y-5">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label={t.companyForm.name}
          required
          {...register('name')}
          error={errors.name?.message}
        />
        <Input
          label={t.companyForm.industry}
          placeholder={t.companyForm.industryPlaceholder}
          {...register('industry')}
          error={errors.industry?.message}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label={t.companyForm.contactEmail}
          type="email"
          {...register('contactEmail')}
          error={errors.contactEmail?.message}
        />
        <Input
          label={t.companyForm.size}
          placeholder={t.companyForm.sizePlaceholder}
          {...register('size')}
          error={errors.size?.message}
        />
        <Input
          label={t.companyForm.logoUrl}
          type="url"
          placeholder="https://..."
          {...register('logoUrl')}
          error={errors.logoUrl?.message}
        />
        <Input
          label={t.companyForm.quota}
          type="number"
          min={0}
          placeholder={t.companyForm.quotaPlaceholder}
          {...register('quota')}
          error={errors.quota?.message}
        />
      </div>

      <Input
        label={t.companyForm.address}
        placeholder={t.companyForm.addressPlaceholder}
        {...register('address')}
        error={errors.address?.message}
      />

      {/* Paste-in enrichment (#2055): proposals only — no website is fetched. */}
      <EnrichPanel
        endpoint="/api/admin/ai/company-enrich"
        testId="company-enrich"
        fields={[
          { key: 'description', label: t.enrich.fields.description },
          { key: 'industry', label: t.enrich.fields.industry },
        ]}
        onAccept={(key, value) => {
          if (key === 'description' || key === 'industry') setValue(key, String(value), { shouldDirty: true });
        }}
      />

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.companyForm.description}</label>
        <Textarea
          {...register('description')}
          rows={3}
          maxLength={TEXT_LIMITS.companyDescription}
          placeholder={t.companyForm.descriptionPlaceholder}
          showCounter
        />
      </div>

      {/* Open positions are Requisitions (#1875) — the old free-text "needs"
          list this form used to write is retired; it is managed on the
          requisitions screen, filtered to this company when editing. */}
      {hasPositions && (
      <div className="rounded-lg border border-dashed border-gray-200 p-3 text-sm text-gray-600" data-testid="company-form-positions">
        <p className="font-medium text-gray-700">{t.companyForm.needs}</p>
        <p className="mt-1">
          {t.companyForm.positionsMoved}{' '}
          <Link
            href={companyId ? `/admin/requisitions?companyId=${encodeURIComponent(companyId)}` : '/admin/requisitions'}
            className="text-blue-600 hover:underline"
          >
            {t.companyForm.managePositions}
          </Link>
        </p>
      </div>
      )}

      <div className="flex justify-end gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t.companyForm.cancel}
        </Button>
        <Button type="submit" loading={loading}>
          {isEditing ? t.companyForm.update : t.companyForm.create}
        </Button>
      </div>
    </form>
  );
}
