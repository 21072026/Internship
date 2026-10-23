// Client-safe vocabulary of a bug report's triage state (#3130); the enum
// itself is `SupportReportStatus` in prisma/schema.prisma.
export const SUPPORT_REPORT_STATUSES = ['NEW', 'TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX'] as const;
export type SupportReportStatusKey = (typeof SUPPORT_REPORT_STATUSES)[number];

export const SUPPORT_REPORT_STATUS_VARIANT: Record<SupportReportStatusKey, 'info' | 'warning' | 'success' | 'default' | 'purple'> = {
  NEW: 'info', TRIAGED: 'purple', IN_PROGRESS: 'warning', RESOLVED: 'success', WONT_FIX: 'default',
};
