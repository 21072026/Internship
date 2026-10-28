'use client';

import { useT } from '@/i18n/client';
import { AvailabilityEditor } from '@/components/availability/AvailabilityEditor';

export default function AvailabilityPage() {
  const t = useT();
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.availability.title}</h1>
        <p className="text-gray-500 mt-1">{t.availability.subtitle}</p>
      </div>
      <AvailabilityEditor />
    </div>
  );
}
