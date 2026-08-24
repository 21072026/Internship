'use client';

import { Download } from 'lucide-react';

/**
 * Take-away copy of the accepted text (#1025).
 *
 * A blob built in the browser, not a server route: the body is already on the
 * page, so a download endpoint would be a second way to reach the same bytes
 * and one more thing to keep authorised.
 */
export function ContributorTermsDownload({
  body,
  filename,
  label,
}: {
  body: string;
  filename: string;
  label: string;
}) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <button
      type="button"
      onClick={download}
      data-testid="terms-download"
      className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
    >
      <Download className="h-4 w-4" />
      {label}
    </button>
  );
}
