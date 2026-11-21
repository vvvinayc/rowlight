// Pending row edits for one editable result: cell edits, deleted rows and new rows.
// Nothing touches the database until the user clicks "Save" in the pending-changes panel.

import { useCallback, useMemo, useState } from 'react';
import type { ChangeSet, EditInfo, RowValues } from '../../shared/types';

export interface GridEditApi {
  isEditableCol(c: number): boolean;
  value(r: number, c: number): unknown;
  isDirty(r: number, c: number): boolean;
  rowState(r: number): 'deleted' | 'inserted' | undefined;
  setCell(r: number, c: number, v: unknown): void;
  toggleDelete(rows: number[]): void;
  addRow(): number;
}

export interface PendingItem {
  kind: 'update' | 'insert' | 'delete';
  row: number;
  label: string;
}

interface InsertedRow {
  values: unknown[];
  touched: Set<number>;
}

const fmt = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v)}'`);

export function useRowEdits(baseRows: unknown[][], edit: EditInfo | undefined) {
  const [edits, setEdits] = useState<Map<number, Map<number, unknown>>>(new Map());
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [inserted, setInserted] = useState<InsertedRow[]>([]);
  const n = baseRows.length;

  const reset = useCallback(() => {
    setEdits(new Map());
    setDeleted(new Set());
    setInserted([]);
  }, []);

  const rows = useMemo(() => (inserted.length ? baseRows.concat(inserted.map((r) => r.values)) : baseRows), [baseRows, inserted]);

  const keyOf = useCallback((r: number): RowValues => {
    const key: RowValues = {};
    for (const k of edit!.keyColumns) key[k] = baseRows[r][edit!.columnMap.indexOf(k)];
    return key;
  }, [baseRows, edit]);

  const api: GridEditApi | undefined = useMemo(() => {
    if (!edit) return undefined;
    return {
      isEditableCol: (c) => edit.columnMap[c] != null,
      value: (r, c) => (r < n ? (edits.get(r)?.has(c) ? edits.get(r)!.get(c) : baseRows[r][c]) : inserted[r - n]?.values[c]),
      isDirty: (r, c) => (r < n ? !!edits.get(r)?.has(c) : !!inserted[r - n]?.touched.has(c)),
      rowState: (r) => (r >= n ? 'inserted' : deleted.has(r) ? 'deleted' : undefined),
      setCell: (r, c, v) => {
        if (edit.columnMap[c] == null) return;
        if (r >= n) {
          setInserted((list) => list.map((row, i) => (i === r - n
            ? { values: row.values.map((x, j) => (j === c ? v : x)), touched: new Set(row.touched).add(c) }
            : row)));
          return;
        }
        setEdits((m) => {
          const next = new Map(m);
          const cells = new Map(next.get(r) ?? []);
          // Editing back to the original value removes the change.
          if (v === baseRows[r][c] || (v !== null && baseRows[r][c] !== null && String(v) === String(baseRows[r][c]))) cells.delete(c);
          else cells.set(c, v);
          if (cells.size) next.set(r, cells);
          else next.delete(r);
          return next;
        });
      },
      toggleDelete: (rs) => {
        const newOnes = rs.filter((r) => r >= n).map((r) => r - n);
        if (newOnes.length) setInserted((list) => list.filter((_, i) => !newOnes.includes(i)));
        const base = rs.filter((r) => r < n);
        if (base.length) {
          setDeleted((d) => {
            const next = new Set(d);
            const allDeleted = base.every((r) => next.has(r));
            for (const r of base) (allDeleted ? next.delete(r) : next.add(r));
            return next;
          });
        }
      },
      addRow: () => {
        setInserted((list) => [...list, { values: edit.columnMap.map(() => null), touched: new Set() }]);
        return n + inserted.length;
      },
    };
  }, [edit, edits, deleted, inserted, baseRows, n]);

  /** Human-readable list for the pending-changes panel. */
  const pending: PendingItem[] = useMemo(() => {
    if (!edit) return [];
    const out: PendingItem[] = [];
    const keyText = (r: number) => edit.keyColumns.map((k) => `${k}=${fmt(baseRows[r][edit.columnMap.indexOf(k)])}`).join(', ');
    for (const r of [...deleted].sort((a, b) => a - b)) out.push({ kind: 'delete', row: r, label: `Delete row ${keyText(r)}` });
    for (const [r, cells] of [...edits].sort((a, b) => a[0] - b[0])) {
      if (deleted.has(r)) continue;
      const parts = [...cells].map(([c, v]) => `${edit.columnMap[c]}: ${fmt(baseRows[r][c])} → ${fmt(v)}`);
      out.push({ kind: 'update', row: r, label: `Update ${keyText(r)} · ${parts.join(' · ')}` });
    }
    inserted.forEach((row, i) => {
      const parts = [...row.touched].map((c) => `${edit.columnMap[c]}=${fmt(row.values[c])}`);
      out.push({ kind: 'insert', row: n + i, label: `Insert new row ${parts.length ? parts.join(', ') : '(all defaults)'}` });
    });
    return out;
  }, [edit, edits, deleted, inserted, baseRows, n]);

  function revert(item: PendingItem) {
    if (item.kind === 'delete') setDeleted((d) => { const x = new Set(d); x.delete(item.row); return x; });
    if (item.kind === 'update') setEdits((m) => { const x = new Map(m); x.delete(item.row); return x; });
    if (item.kind === 'insert') setInserted((list) => list.filter((_, i) => i !== item.row - n));
  }

  /** The change set sent to the main process. */
  function changeSet(): ChangeSet | null {
    if (!edit) return null;
    const c: ChangeSet = { edit, updates: [], inserts: [], deletes: [] };
    for (const r of deleted) c.deletes.push({ key: keyOf(r) });
    for (const [r, cells] of edits) {
      if (deleted.has(r)) continue;
      const set: RowValues = {};
      for (const [col, v] of cells) set[edit.columnMap[col]!] = v;
      c.updates.push({ key: keyOf(r), set });
    }
    for (const row of inserted) {
      const values: RowValues = {};
      for (const col of row.touched) values[edit.columnMap[col]!] = row.values[col];
      c.inserts.push(values);
    }
    return c;
  }

  return { rows, api, pending, revert, reset, changeSet };
}
