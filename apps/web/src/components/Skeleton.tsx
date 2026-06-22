export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-pulse bg-gray-200 dark:bg-gray-800 rounded ${className}`} />
  );
}

export function StatSkeleton() {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-5 py-4">
      <Skeleton className="h-3 w-16 mb-2" />
      <Skeleton className="h-8 w-24 mb-1" />
      <Skeleton className="h-3 w-20" />
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
      <Skeleton className="h-4 w-32 mb-6" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
