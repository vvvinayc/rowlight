// Keyboard shortcuts reference (F1 or Ctrl+/). Grouped and searchable.

import React, { useEffect, useRef, useState } from 'react';

const GROUPS: { title: string; items: [keys: string, what: string, how?: string][] }[] = [
  {
    title: 'Tabs, files and window',
    items: [
      ['Ctrl+E', 'New query tab'],
      ['Ctrl+W', 'Close the current tab'],
      ['Middle-click a tab', 'Close that tab'],
      ['Ctrl+O', 'Open a .sql file'],
      ['Ctrl+S', 'Save the tab to a .sql file'],
      ['Ctrl+Shift+S', 'Save as…'],
      ['Ctrl+B', 'Hide / show the connections panel (also the ☰ button)', "Gives the editor and results the full width. Rowlight remembers it."],
      ['Ctrl+R', 'Hide / show the results panel', "Gives the editor the full height. Running a query shows the results again."],
      ['Esc', 'Close a dialog'],
    ],
  },
  {
    title: 'Running queries',
    items: [
      ['Ctrl+Enter', 'Run the selection, or the statement under the cursor (it flashes). Setting off: the whole script', "Put the cursor anywhere inside a query: only that query runs. Queries are separated by ; or by an empty line. Select text to run just that."],
      ['Ctrl+Shift+Enter', 'Run the whole script (also the ▶▶ Script button)', "Every query in the tab runs, one after the other; each result gets its own tab."],
      ['Ctrl+Shift+F', 'Format the selection, or the whole script (adds missing ";")'],
      ['Ctrl+.', 'Quick fix on the underlined word, e.g. "Add ;"', "Click on the underlined word, press Ctrl+. and pick the fix from the menu."],
      ['F8 / Shift+F8', 'Go to the next / previous warning'],
    ],
  },
  {
    title: 'Suggestions',
    items: [
      ['Ctrl+Space', 'Show suggestions (tables, columns, joins, functions, snippets)', "After FROM: tables; after \"la.\": columns; after JOIN \u2026 ON: join conditions. Type sel, cnt or dup and press Tab for a ready query."],
      ['Tab / Enter', 'Accept the highlighted suggestion'],
      ['Esc', 'Close the suggestion list'],
      ['Ctrl+Shift+Space', 'Show the parameters of the function'],
    ],
  },
  {
    title: 'Box selection and multiple cursors',
    items: [
      ['Alt+drag', 'Box (column) selection, like SSMS: type once and every line gets it', "Hold Alt, press the mouse at the start of the first line and drag straight down. A thin cursor shows on every line; type \"la.\" and all lines get it. Drag sideways too to select a block and delete or replace it on every line."],
      ['Shift+Alt+drag', 'Box selection (also works)'],
      ['Ctrl+Shift+Alt+Up / Ctrl+Shift+Alt+Down', 'Box selection with the keyboard: add the line above / below', "Put the cursor at the start of the first line, hold Ctrl+Shift+Alt and press \u2193 once per line, then type."],
      ['Ctrl+Shift+Alt+Left / Ctrl+Shift+Alt+Right', 'Box selection with the keyboard: make the box wider / narrower'],
      ['Ctrl+Click', 'Add another cursor', "Hold Ctrl and click in several places; typing goes to all of them. Esc goes back to one cursor."],
      ['Ctrl+Alt+Up / Ctrl+Alt+Down', 'Add a cursor on the line above / below'],
      ['Shift+Alt+I', 'A cursor at the end of every selected line', "Select some lines, press Shift+Alt+I, then type \",\" to add a comma at the end of each."],
      ['Ctrl+D', 'Also select the next occurrence of the word', "Double-click a word, press Ctrl+D a few times, then type to rename all of them at once."],
      ['Ctrl+Shift+L', 'Select all occurrences of the word'],
      ['Ctrl+U', 'Undo the last cursor'],
      ['Esc', 'Back to one cursor'],
    ],
  },
  {
    title: 'Editing',
    items: [
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
      ['Ctrl+X / Ctrl+C', 'Cut / copy (the whole line when nothing is selected)'],
      ['Ctrl+L', 'Select the line'],
      ['Alt+Up / Alt+Down', 'Move the line up / down'],
      ['Shift+Alt+Up / Shift+Alt+Down', 'Duplicate the line up / down'],
      ['Ctrl+Shift+K', 'Delete the line'],
      ['Ctrl+Enter', 'Runs the query (not "insert line below")'],
      ['Ctrl+] / Ctrl+[', 'Indent / outdent'],
      ['Ctrl+/', 'Comment / uncomment the line'],
      ['Shift+Alt+A', 'Block comment /* … */'],
      ['Ctrl+Backspace / Ctrl+Delete', 'Delete the word before / after'],
    ],
  },
  {
    title: 'Find and move',
    items: [
      ['Ctrl+F', 'Find in the editor'],
      ['Ctrl+H', 'Find and replace'],
      ['F3 / Shift+F3', 'Find next / previous'],
      ['Ctrl+G', 'Go to line'],
      ['Ctrl+Home / Ctrl+End', 'Start / end of the script'],
      ['Ctrl+Left / Ctrl+Right', 'Jump one word'],
      ['Ctrl+Shift+\\', 'Jump to the matching bracket'],
    ],
  },
  {
    title: 'Results grid',
    items: [
      ['Click / Shift+Click', 'Select a cell / extend the selection to here'],
      ['Arrow keys', 'Move between cells (scrolls sideways to hidden columns)'],
      ['Shift+Arrows', 'Extend the selection'],
      ['Home / Shift+End', 'Select (and copy) the whole row: Home, then Shift+End, then Ctrl+C', "Click a cell in the row, press Home, then Shift+End. Shift+\u2193 adds the next rows. Ctrl+Shift+C copies with column names."],
      ['PageUp / PageDown', 'Move one page'],
      ['Home / End', 'First / last column'],
      ['Ctrl+Home / Ctrl+End', 'First / last cell (End of a limited result loads more rows)'],
      ['Ctrl+A', 'Select all cells'],
      ['Ctrl+C', 'Copy the selected cells (paste into Excel)', "Cells are copied tab-separated, so they paste into Excel columns. Generate SQL\u2026 gives the rows as INSERT / UPDATE / DELETE."],
      ['Ctrl+Shift+C', 'Copy with column headers'],
      ['F2 / Enter / typing', 'Edit the cell (editable results only)', "Works when the result comes from one table with a primary key and read-only is off. Changes are only saved when you click Save."],
      ['Delete', 'Set the cell to NULL (editable results only)'],
      ['Enter', 'While editing: save and move down'],
      ['Tab / Shift+Tab', 'While editing: save and move right / left'],
      ['Esc', 'While editing: cancel'],
      ['Double-click a cell', 'Open the full value (editable results: edit it)'],
      ['Click a column name', 'Sort (click again: reverse, third click: off)'],
    ],
  },
  {
    title: 'View',
    items: [
      ['Ctrl+= / Ctrl+-', 'Zoom in / out'],
      ['Ctrl+0', 'Reset zoom'],
      ['Ctrl+Mouse wheel', 'Zoom in / out'],
      ['F1 / Ctrl+/', 'This list of shortcuts (Ctrl+/ outside the editor)'],
      ['F12', 'Developer tools'],
      ['Ctrl+Shift+R', 'Reload the window'],
    ],
  },
];

/** "ctrl shift alt", "Ctrl+Shift+Alt" and "box select" all match: every word must appear somewhere. */
function matches(text: string, query: string): boolean {
  const hay = text.toLowerCase().replace(/[+]/g, ' ');
  return query.toLowerCase().replace(/[+]/g, ' ').split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const s = q.trim().toLowerCase();
  const groups = GROUPS.map((g) => ({
    ...g,
    items: s ? g.items.filter(([k, w, how]) => matches(k + ' ' + w + ' ' + (how ?? '') + ' ' + g.title, s)) : g.items,
  })).filter((g) => g.items.length);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal shortcuts" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <h3>⌨ Keyboard shortcuts</h3>
        <input ref={input} className="shortcuts-search" placeholder="Search shortcuts… (e.g. copy, box, ctrl shift alt)" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="shortcuts-body">
          {groups.length === 0 && <div className="muted pad">No shortcut matches “{q}”.</div>}
          {groups.map((g) => (
            <div key={g.title} className="shortcuts-group">
              <h4>{g.title}</h4>
              <table>
                <tbody>
                  {g.items.map(([k, w, how]) => (
                    <tr key={k + w}>
                      <td className="keys">{k.split(' / ').map((part, i) => (
                        <React.Fragment key={i}>{i > 0 && ' / '}<span className="combo">{part.split('+').map((key, j) => (
                          <React.Fragment key={j}>{j > 0 && '+'}<kbd>{key}</kbd></React.Fragment>
                        ))}</span></React.Fragment>
                      ))}</td>
                      <td>{w}{how && <div className="shortcut-how">{how}</div>}</td>
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
