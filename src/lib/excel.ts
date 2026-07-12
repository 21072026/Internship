// Client-side Excel (.xlsx) export. SheetJS is imported dynamically so it is
// code-split out of the main bundle and only loaded on demand.
export async function exportXlsx(
  filename: string,
  columns: string[],
  rows: (string | number | null | undefined)[][],
  sheetName = 'Sheet1'
) {
  await exportXlsxSheets(filename, [{ name: sheetName, columns, rows }]);
}

// Multi-sheet variant (premium full report, #540): one workbook, one sheet per
// section. Sheet names are capped at Excel's 31-char limit.
export async function exportXlsxSheets(
  filename: string,
  sheets: { name: string; columns: string[]; rows: (string | number | null | undefined)[][] }[]
) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const data = [s.columns, ...s.rows.map((r) => r.map((c) => (c == null ? '' : c)))];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), s.name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}
