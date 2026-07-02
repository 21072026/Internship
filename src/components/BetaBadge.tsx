// Small "beta" badge shown next to the brand wordmark while the app is
// pre-1.0. Kept as a tiny presentational component so every placement stays
// consistent and the label can be changed in one place.
export function BetaBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 ${className}`}
      title="Beta"
      aria-label="Beta"
    >
      beta
    </span>
  );
}
