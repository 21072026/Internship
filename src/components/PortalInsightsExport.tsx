'use client';

import { Download, Printer } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { exportXlsx } from '@/lib/excel';

// The mentee's own report as a workbook, and the print layout (#1909). The rows
// are what the page already rendered for this period — built on the server from
// the session's own id, so there is nothing here to point at someone else.
// Never gated: a participant's own data is free core.
export function PortalInsightsExport({
  filename,
  columns,
  rows,
  exportLabel,
  printLabel,
}: {
  filename: string;
  columns: string[];
  rows: (string | number)[][];
  exportLabel: string;
  printLabel: string;
}) {
  return (
    <div className="flex items-center gap-2 no-print">
      <Button variant="outline" size="sm" onClick={() => void exportXlsx(filename, columns, rows)} data-testid="portal-insights-export">
        <Download className="mr-1 h-4 w-4" aria-hidden="true" />
        {exportLabel}
      </Button>
      <Button variant="outline" size="sm" onClick={() => window.print()} data-testid="portal-insights-print">
        <Printer className="mr-1 h-4 w-4" aria-hidden="true" />
        {printLabel}
      </Button>
    </div>
  );
}
