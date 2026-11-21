// Export a result grid to CSV or Excel (.xlsx).

import { BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import ExcelJS from 'exceljs';

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * DECIMAL/BIGINT arrive as strings; write them as real numbers when that is lossless
 * (max 15 significant digits, no leading zeros, so IDs / account numbers stay text).
 */
function excelValue(v: unknown): unknown {
  if (typeof v === 'string' && /^-?(0|[1-9]\d{0,14})(\.\d{1,10})?$/.test(v) && v.replace(/[-.]/g, '').length <= 15) return Number(v);
  return v;
}

/** Returns the saved file path, or null if the user cancelled the dialog. */
export async function exportResult(
  win: BrowserWindow, format: 'csv' | 'xlsx', columns: string[], rows: unknown[][], baseName: string,
): Promise<string | null> {
  const safe = (baseName || 'result').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `${safe}.${format}`,
    filters: format === 'csv' ? [{ name: 'CSV', extensions: ['csv'] }] : [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  if (canceled || !filePath) return null;

  if (format === 'csv') {
    const out = fs.createWriteStream(filePath, { encoding: 'utf8' });
    out.write('﻿'); // BOM so Excel opens UTF-8 correctly
    out.write(columns.map(csvCell).join(',') + '\r\n');
    for (const r of rows) out.write(r.map(csvCell).join(',') + '\r\n');
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    return filePath;
  }

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: true });
  const ws = wb.addWorksheet('Result', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c, key: c, width: Math.min(60, Math.max(10, c.length + 2)) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).commit();
  for (const r of rows) ws.addRow(r.map(excelValue)).commit();
  ws.commit();
  await wb.commit();
  return filePath;
}
