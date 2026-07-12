import Link from 'next/link';
import { ArrowLeft, GraduationCap } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { getFeatures, FEATURE_CATEGORIES } from '@/lib/features';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';

const iconBg: Record<string, string> = {
  blue: 'bg-blue-100 text-blue-600', green: 'bg-green-100 text-green-600',
  purple: 'bg-purple-100 text-purple-600', amber: 'bg-amber-100 text-amber-600',
  teal: 'bg-teal-100 text-teal-600', orange: 'bg-orange-100 text-orange-600',
  sky: 'bg-sky-100 text-sky-600', rose: 'bg-rose-100 text-rose-600',
  indigo: 'bg-indigo-100 text-indigo-600',
};

// Public feature catalogue (#584/#587) — every shipped feature, categorized,
// fed from the single source in src/lib/features.ts (same data as the landing
// page's featured cards).
export default async function FeaturesPage() {
  const { t, locale } = await getServerDictionary();
  const F = t.featureCatalog;
  const features = getFeatures(t);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950">
      <header className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-bold text-gray-900 dark:text-gray-100">
          <GraduationCap className="h-6 w-6 text-blue-600" /> InternshipCRM
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSwitcher current={locale} />
          <ThemeToggle />
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 pb-16">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline mb-6">
          <ArrowLeft className="h-4 w-4" /> {F.backHome}
        </Link>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">{F.title}</h1>
        <p className="text-gray-500 dark:text-gray-400 mb-10">{F.subtitle}</p>

        {FEATURE_CATEGORIES.map((cat) => {
          const inCat = features.filter((f) => f.category === cat);
          if (inCat.length === 0) return null;
          return (
            <section key={cat} className="mb-10" data-testid={`feature-cat-${cat}`}>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{F.categories[cat]}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {inCat.map((f) => (
                  <div key={f.key} className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 ${iconBg[f.color] ?? iconBg.blue}`}>
                      <f.icon className="h-5 w-5" />
                    </div>
                    <p className="font-semibold text-gray-900 dark:text-gray-100">{f.title}</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{f.desc}</p>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}
