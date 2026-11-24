// Keyboard shortcuts reference (F1 or Ctrl+/). Grouped and searchable.

import React, { useEffect, useRef, useState } from 'react';

const GROUPS: { title: string; items: [keys: string, what: string][] }[] = [
  {
    title: 'Tabs and files',
    items: [
      ['Ctrl+E', 'New query tab'],
      ['Ctrl+W', 'Close the current tab'],
      ['Ctrl+O', 'Open a .sql file'],
      ['Ctrl+S', 'Save the tab to a .sql file'],
      ['Ctrl+Shift+S', 'Save as…'],
      ['Ctrl+B', 'Hide / show the connections panel (also the ☰ button)'],
    ],
  },
  {
    title: 'Running queries',
    items: [
      ['Ctrl+Enter', 'Run the selection, or the statement under the cursor (Settings → Smart features: or the whole script)'],
      ['Ctrl+Shift+Enter', 'Run the whole script'],
      ['Ctrl+R', 'Hide / show the results panel'],
      ['Ctrl+Shift+F', 'Format the selection, or the whole script (adds missing ";")'],
      ['Ctrl+.', 'Quick fix on the underlined word, e.g. "Add ;"'],
    ],
  },
  {
    title: 'Editor',
    items: [
      ['Ctrl+Space', 'Show suggestions (tables, columns, joins, functions, snippets)'],
      ['Tab / Enter', 'Accept the highlighted suggestion'],
      ['Esc', 'Close the suggestion list'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
      ['Ctrl+F', 'Find in the editor'],
      ['Ctrl+H', 'Find and replace'],
      ['Ctrl+D', 'Select the next occurrence of the word'],
      ['Alt+Up / Alt+Down', 'Move the line up / down'],
      ['Shift+Alt+Down', 'Duplicate the line'],
      ['Ctrl+Shift+K', 'Delete the line'],
      ['Ctrl+/', 'Comment / uncomment the line (in the editor)'],
      ['Alt+drag', 'Box (column) selection, like SSMS: type once and every line gets it'],
      ['Ctrl+Shift+Alt+Arrows', 'Box selection with the keyboard'],
      ['Ctrl+Click', 'Add another cursor'],
    ],
  },
  {
    title: 'Results grid',
    items: [
      ['Arrow keys', 'Move between cells (scrolls sideways to hidden columns)'],
      ['Shift+Arrows', 'Extend the selection'],
      ['PageUp / PageDown', 'Move one page'],
      ['Home / End', 'First / last column'],
      ['Ctrl+Home / Ctrl+End', 'First / last cell (End of a limited result loads more rows)'],
      ['Ctrl+A', 'Select all cells'],
      ['Ctrl+C', 'Copy the selected cells'],
      ['Ctrl+Shift+C', 'Copy with column headers'],
      ['F2 / Enter / typing', 'Edit the cell (editable results only)'],
      ['Delete', 'Set the cell to NULL (editable results only)'],
      ['Tab / Shift+Tab', 'While editing: save and move right / left'],
      ['Esc', 'While editing: cancel'],
    ],
  },
  {
    title: 'View',
    items: [
      ['Ctrl+= / Ctrl+-', 'Zoom in / out'],
      ['Ctrl+0', 'Reset zoom'],
      ['Ctrl+Mouse wheel', 'Zoom in / out'],
      ['F1', 'This list of shortcuts (outside the editor too)'],
      ['F12', 'Developer tools'],
      ['Ctrl+Shift+R', 'Reload the window'],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const s = q.trim().toLowerCase();
  const groups = GROUPS.map((g) => ({
    ...g,
    items: s ? g.items.filter(([k, w]) => (k + ' ' + w + ' ' + g.title).toLowerCase().includes(s)) : g.items,
  })).filter((g) => g.items.length);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal shortcuts" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <h3>⌨ Keyboard shortcuts</h3>
        <input ref={input} className="shortcuts-search" placeholder="Search shortcuts… (e.g. copy, zoom, run)" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="shortcuts-body">
          {groups.length === 0 && <div className="muted pad">No shortcut matches “{q}”.</div>}
          {groups.map((g) => (
            <div key={g.title} className="shortcuts-group">
              <h4>{g.title}</h4>
              <table>
                <tbody>
                  {g.items.map(([k, w]) => (
                    <tr key={k + w}>
                      <td className="keys">{k.split(' / ').map((part, i) => (
                        <React.Fragment key={i}>{i > 0 && ' / '}{part.split('+').map((key, j) => (
                          <React.Fragment key={j}>{j > 0 && '+'}<kbd>{key}</kbd></React.Fragment>
                        ))}</React.Fragment>
                      ))}</td>
                      <td>{w}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <div className="modal-actions"><span className="muted small">F1 or Ctrl+/ opens this list</span><span className="spacer" /><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
