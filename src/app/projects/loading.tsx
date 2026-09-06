import { ListPageSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for the public project showcase. No layout in this tree,
// so the fallback brings its own page container.
export default function ProjectsLoading() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto max-w-5xl p-4 lg:p-8">
        <ListPageSkeleton rows={6} />
      </div>
    </div>
  );
}
