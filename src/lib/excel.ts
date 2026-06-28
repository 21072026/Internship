// Client-side Excel (.xlsx) export. SheetJS is imported dynamically so it is
// code-split out of the main bundle and only loaded on demand.
export async function exportXlsx(
  filename: string,
  columns: string[],
  rows: (string | number | null | undefined)[][],
  sheetName = 'Sheet1'
) {
  const XLSX = await import('xlsx');
  const data = [columns, ...rows.map((r) => r.map((c) => (c == null ? '' : c)))];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}
