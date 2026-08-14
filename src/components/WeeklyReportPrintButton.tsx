'use client';

import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function WeeklyReportPrintButton({ label }: { label: string }) {
  return <Button className="no-print" onClick={() => window.print()}><Printer className="h-4 w-4" />{label}</Button>;
}
