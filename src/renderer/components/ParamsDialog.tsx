// Asks for the values of :name parameters before a query runs. Remembers the last value of each name.

import React, { useState } from 'react';
import { sqlLiteral } from '../../shared/sqlParams';

const KEY = 'rowlight.paramValues';

function remembered(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; }
}

export function ParamsDialog({ names, onDone }: { names: string[]; onDone(values: Record<string, string> | null): void }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const r = remembered();
    return Object.fromEntries(names.map((n) => [n, r[n] ?? '']));
  });
  const ok = () => {
    try { localStorage.setItem(KEY, JSON.stringify({ ...remembered(), ...values })); } catch { /* not important */ }
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
                  onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))} /></td>
                <td className="muted small param-sql">{values[n].trim() ? sqlLiteral(values[n]) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted small">Numbers and NULL are used as they are; text gets quotes. For IN, type 1,2,3 or ('A','B').</div>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="primary">Run</button>
        </div>
      </form>
    </div>
  );
}
