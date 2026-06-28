// Small avatar for sidebars/lists: shows the uploaded image or a colored initial.
export function SidebarAvatar({
  avatarUrl,
  name,
  fallback = '?',
  className = 'bg-blue-100 text-blue-700',
}: {
  avatarUrl?: string | null;
  name?: string | null;
  fallback?: string;
  className?: string;
}) {
  if (avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover border border-gray-200" />;
  }
  return (
    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${className}`}>
      <span className="font-semibold text-sm">{name?.[0] || fallback}</span>
    </div>
  );
}
