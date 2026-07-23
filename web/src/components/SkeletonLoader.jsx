import React from 'react';

export function CardSkeleton({ count = 4 }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="p-5 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/80 dark:border-slate-700/80 shadow-sm animate-pulse">
          <div className="h-4 w-28 bg-slate-200 dark:bg-slate-700 rounded mb-3"></div>
          <div className="h-8 w-36 bg-slate-300 dark:bg-slate-600 rounded mb-2"></div>
          <div className="h-3 w-20 bg-slate-200 dark:bg-slate-700 rounded"></div>
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/80 dark:border-slate-700/80 shadow-sm p-5 animate-pulse">
      <div className="flex justify-between items-center mb-6">
        <div className="h-6 w-48 bg-slate-200 dark:bg-slate-700 rounded"></div>
        <div className="h-9 w-64 bg-slate-200 dark:bg-slate-700 rounded-xl"></div>
      </div>
      <div className="space-y-3">
        <div className="h-10 bg-slate-100 dark:bg-slate-700/50 rounded-xl"></div>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-12 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-700/40"></div>
        ))}
      </div>
    </div>
  );
}
