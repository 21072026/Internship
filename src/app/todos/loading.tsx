import { ListPageSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for /todos.
export default function TodosLoading() {
  return <ListPageSkeleton rows={6} />;
}
