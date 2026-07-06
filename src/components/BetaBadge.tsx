import { IS_PREVIEW } from '@/lib/appEnv';

// Small badge shown next to the brand wordmark while the app is pre-1.0. Kept as
// a tiny presentational component so every placement stays consistent and the
// label lives in one place. On the preview deployment it turns green and reads
// "preview" so the environment is unmistakable; production keeps the amber
// "beta".
export function BetaBadge({ className = '' }: { className?: string }) {
  const styles = IS_PREVIEW
    ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
  const label = IS_PREVIEW ? 'preview' : 'beta';
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide ${styles} ${className}`}
      title={label}
      aria-label={label}
    >
      {label}
    </span>
  );
}
