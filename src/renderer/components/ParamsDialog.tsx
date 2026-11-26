// Asks for the values of :name parameters before a query runs. Remembers the last value of each name.

import React, { useState } from 'react';
import { sqlLiteral } from '../../shared/sqlParams';
import { pastedList, toSqlList } from '../../shared/pasteList';
import { getPrivate, setPrivate } from '../privateStore';

const KEY = 'rowlight.paramValues';

function remembered(): Record<string, string> {
  try { return JSON.parse(getPrivate(KEY) ?? '{}') ?? {}; } catch { return {}; }
}

export function ParamsDialog({ names, textNames, onDone }: { names: string[]; /** Parameters used with a text column: pasted numbers get quotes. */ textNames?: string[]; onDone(values: Record<string, string> | null): void }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const r = remembered();
    return Object.fromEntries(names.map((n) => [n, r[n] ?? '']));
  });
  const ok = () => {
    setPrivate(KEY, JSON.stringify({ ...remembered(), ...values }));
    onDone(values);
  };
  return (
    <div className="modal-backdrop" onMouseDown={() => onDone(null)}>
      <form className="modal params-dialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); ok(); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(null); } }}>
        <h3>Values for the query</h3>
        <table>
          <tbody>
            {names.map((n, i) => (
              <tr key={n}>
                <td className="param-name">:{n}</td>
                <td><input autoFocus={i === 0} value={values[n]} onFocus={(e) => e.target.select()}
                  onPaste={(e) => {
                    // A pasted column of values becomes 'a', 'b', 'c' (for IN (:ids)).
                    const items = pastedList(e.clipboardData.getData('text'));
                    if (!items) return;
                    e.preventDefault();
                    setValues((v) => ({ ...v, [n]: toSqlList(items, '  ', !!textNames?.includes(n)).replace(/\s*\n\s*/g, ' ').trim() }));
                  }}
                  onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))} /></td>
                <td className="muted small param-sql">{values[n].trim() ? sqlLiteral(values[n]) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted small">Numbers and NULL are used as they are; text gets quotes. For IN, type 1,2,3 or paste a column of values (they get quotes).</div>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="primary">Run</button>
        </div>
      </form>
    </div>
  );
}
