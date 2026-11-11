// A customer as the affiliate screens show it (#3352): the admin-written label
// when there is one, with the product-side reference under it; the reference
// alone otherwise. Server- and client-safe.
export function CustomerName({ label, reference }: { label: string | null; reference: string }) {
  if (!label) return <span className="font-mono">{reference}</span>;
  return (
    <span className="flex flex-col">
      <span>{label}</span>
      <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{reference}</span>
    </span>
  );
}
