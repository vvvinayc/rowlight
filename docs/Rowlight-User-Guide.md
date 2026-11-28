# Rowlight User Guide

Version 0.15.2. Rowlight is a Windows SQL client for **MySQL** and **SQL Server**, with SSH tunnels, a fast results grid, smart offline suggestions and safety for production databases.

Press **F1** in the app at any time for the full keyboard shortcut list with short how-to notes and a search box.

## Contents

1. Install and update
2. Connections
3. Working with several connections
4. Writing queries
5. Suggestions
6. Running queries
7. Pasting values
8. Parameters (:name)
9. Saved queries
10. Results grid
11. JSON
12. Editing data
13. Compare two connections (LP vs DR)
14. Safety and read-only
15. Security and privacy
16. Share with Claude
17. Settings
18. Keyboard shortcuts
19. Files and troubleshooting

## 1. Install and update

- **Install:** run `Rowlight-Setup-x.y.z.exe` from the GitHub release page. The installer isn't code-signed yet, so Windows SmartScreen may warn: click **More info → Run anyway**.
- **Automatic updates:** Rowlight checks GitHub for a new version when it starts. A bar appears when an update is ready; restart to install it.
- **Check now:** **Settings → Updates → Check for updates now**. An older version updates straight to the latest one; it doesn't install every version in between.
- Updates keep your connections, settings, history and saved queries.

## 2. Connections

### Add a connection
**+ New** in the left panel. Fill in:

| Field | Notes |
|---|---|
| Name | e.g. `KGFS LP Production`. The name sets the default colour and read-only mode (see below). |
| Type | MySQL or SQL Server |
| Host, Port, Database, User | Database is the default database; you can switch it later in the **DB** list. |
| Password | Saved encrypted, or tick **Ask password every time**. |
| Read-only | On by default for names containing PROD or DR. |
| Colour | **A** = automatic from the name, **∅** = no colour, or pick one. |
| Compare with | Partner connection for **⇄ Compare** (e.g. LP ↔ DR). |
| SSH tunnel | Connect through a bastion host: password or key; can use a saved **SSH profile**. |

### SSH profiles
**SSH profiles** (top bar) stores a bastion once (host, user, key or password) to reuse in many connections. The server's host key is remembered and checked on every connect.

### Import and export
**Export** writes your connections to a file to share with a colleague (passwords are not included). **Import** shows a preview first; imported connections are read-only unless the file says otherwise.

### Connect and disconnect
**Connect** on a connection opens a query tab. **⏏** disconnects. **⟳** reloads the table list after schema changes. **✎** edits, **🗑** deletes (with its history).

### Browsing
Expand a connection to see databases → tables → columns. Click a table to open `SELECT * FROM table` in a new tab. The **ⓘ** next to a table shows its details (columns, keys, indexes). The search box at the top finds tables in **all** databases.

## 3. Working with several connections

- **Tabs per connection:** each tab belongs to one connection; its name shows in the tab title.
- **Click a connection on the left** to go to its last-used tab (one opens if it has none). **Ctrl+E** or **+ Query tab** then opens more tabs for that connection. The **SQL** button on a connection always opens a new tab for it.
- **Automatic colours** on tabs, toolbar and the left panel:

| Name contains | Colour |
|---|---|
| UAT, staging, QA, test, SIT | yellow |
| PROD | red |
| DR | orange |
| dev, local | green |

  Change it under **✎ Edit → Colour**.
- **☰ / Ctrl+B** hides or shows the connections panel for more space.
- Open tabs and their text are restored when you start Rowlight again.

## 4. Writing queries

- **No `;` needed between queries.** A blank line ends a statement when the next line starts a new one (`SELECT`, `UPDATE`…). It never splits inside brackets, strings or comments, after `UNION` / `AND` / a comma, or between `INSERT INTO t (…)` and its `SELECT`. A faint underline marks a missing `;`; **Ctrl+.** → *Add ;* adds it, and **Format** adds them all.
- **Format (Ctrl+Shift+F or the Format button):** formats the selection, or the whole script. Keywords in capitals, one clause per line. After formatting, the view goes back to the start of the query (no sideways scrolling).
- **`*` after columns (MySQL):** `select lads.a, lads.b, * from … lads` is a syntax error in MySQL; Rowlight sends it as `lads.*` (several tables: `a.*, b.*`). The status bar shows *"* sent as lads.*"*. **Ctrl+.** → *Use lads.** writes it into the editor.
- **Box selection like SSMS:** hold **Alt** and drag down several lines, then type once: every line gets it. Keyboard: **Ctrl+Shift+Alt+↓**.
- **Several cursors:** **Ctrl+Click** adds a cursor; **Ctrl+D** selects the next occurrence; **Shift+Alt+I** puts a cursor at the end of each selected line.
- **Open / save .sql files:** **Ctrl+O**, **Ctrl+S**, **Ctrl+Shift+S**.
- **Right-click menu in the editor:** ☆ Save this query, ⇄ Compare with another connection…, Make a list `'a', 'b', 'c'`, JSON: format, JSON: one line, Format Document.

## 5. Suggestions

Suggestions work offline (no AI) and appear as you type, or with **Ctrl+Space**.

- **Tables after FROM / JOIN:** inserted with an alias (`loan_accounts la`).
  - **Your own aliases:** Rowlight learns the alias you write for each table from the queries you run and suggests it: *alias lac (yours)*.
  - **Other databases:** tables of every database are suggested, fully named (`encoredb.loan l`, `bi.report_master rm`), after the selected database's own tables. Database names are suggested too; picking one inserts `encoredb.` and lists its tables.
- **Columns after `alias.`:** the columns of that table, most used first.
- **Clause-aware:** different suggestions after `SELECT`, `WHERE`, `GROUP BY` ("all non-aggregated columns"), `ORDER BY` (your `SELECT` aliases), `SET`.
- **JOIN … ON:** join conditions you wrote before (`la.id = lads.loan_id · you used this 12×`), foreign keys, and naming conventions.
- **Functions** with how to use them (`DATE_FORMAT`, `COALESCE`, `TIMESTAMPDIFF`…), and **snippets**: type `sel`, `cnt`, `dup`, `grp`, `top`, `month`, `miss` and press Tab.
- Only the statement under the cursor counts, so aliases of other queries in the tab don't get mixed in.
- **Wrong alias warning:** `la.account_number` in a statement that has no `la` gets a warning underline (usually an alias copied from another query).
- **Did you mean…?** An error like `Unknown column 'custmer_id'` offers `customer_id`; one click fixes and runs again.

## 6. Running queries

| Action | How |
|---|---|
| Run the statement under the cursor | **Ctrl+Enter** or **▶ Run** (the statement flashes so you see what ran) |
| Run the selection | Select text, then Ctrl+Enter |
| Run the whole script | **Ctrl+Shift+Enter** or **▶▶ Script** |
| Cancel | **■ Cancel** |
| Hide / show results | **Ctrl+R** or **▾ Hide** |

- **Auto-LIMIT:** SELECTs without a limit get `LIMIT 1000` (setting). More rows load when you scroll to the bottom, or with **↓ Load next 1000 rows**.
- **Results layout:** **Stacked** (default: every result one below the other, like SSMS) or **Tabs** (one tab per result). The choice is remembered.
- **Messages** shows each statement's time, row count and errors.
- **DB list** in the toolbar switches the database of the tab.
- **History** (top bar): every query you ran on this connection, searchable; click to insert it.

## 7. Pasting values

Copy IDs from Excel, a result or a chat (one per line) and paste:

| Paste after | Result |
|---|---|
| `where loan_id in (` | `('6af45…', '6af5b…', '6afbe…')`; the `)` is added if missing |
| `where loan_id =` | `=` becomes `in (…)`; `<>` becomes `not in (…)` |

- **Quotes follow the column type:** text values always get quotes. Numbers get quotes when the column is a text column (e.g. `loan_id` VARCHAR) and none when it's a number column (INT, BIGINT, DECIMAL). Codes like `007` keep their quotes.
- More than 10 values go one per line.
- **Ctrl+Z** right after pasting gives back the paste exactly as it was.
- Nothing changes inside strings, comments, where no list is expected, or for a single value.
- Also works in the `:ids` value box (see Parameters) and with right-click → **Make a list** on selected lines.
- Switch off: **Settings → Smart features → Pasted list → IN list**.

## 8. Parameters (:name)

Write `where loan_id = :loan` and run. A box asks for `:loan` and shows exactly what will be sent:

- numbers stay numbers, `NULL` is NULL, text gets quotes;
- for `IN (:ids)` type `1,2,3`, or paste a column of values (quoted when the column is text);
- a value starting with `'` or `(` is used exactly as typed;
- the last value of each name is remembered.

`:x` inside strings and comments is ignored, and so are MySQL `@x := 1` and `::` casts. Switch off: **Settings → Smart features → Ask for :name values**.

## 9. Saved queries

- **Save:** put the cursor in a query (or select it), click **☆ Save** in the tab (or right-click → *Save this query*), give it a name.
- **Find:** **Ctrl+P** (or **★ Saved** in the top bar), type a few words of the name or the SQL.
  - **Enter** opens it in a new tab of the current connection.
  - **Ctrl+Enter** opens and runs it.
  - **Insert** puts it at the cursor in the current tab; **✎** renames; **🗑** deletes.
- Most-used queries come first. Saved queries are stored encrypted on this PC.

## 10. Results grid

**Selecting and copying**

| Action | How |
|---|---|
| Select a cell / extend | Click / Shift+Click, arrow keys, Shift+arrows |
| Select a whole row | Click its **row number** (Shift+Click or drag for several) |
| Select everything | Click **#** (top left) or Ctrl+A |
| Copy | **Ctrl+C** (paste into Excel); **Ctrl+Shift+C** with column names |
| See the full value | Double-click a cell |

**Filtering and sorting**
- **Filter all columns…** box: quick text filter over every column.
- **filter** row under the column names: per-column filter.
- **Right-click a cell:**
  - **Filter: column = value** keeps only rows with that value;
  - **Exclude: column ≠ value** hides them;
  - each shows as a chip above the grid, and **×** removes it (NULL works too);
  - **Copy value**;
  - **Copy as condition** gives `loan_id = '2705820'` for a WHERE.
- Click a column name to sort (again: reverse, third time: off).
- **Clear filters/sort** resets all of these.

**Totals bar:** select several cells and the bar below the grid shows **Count, Sum, Avg, Min, Max**, like Excel (also for decimals stored as text). Click a number to copy it.

**Export:** **Export CSV** / **Export Excel** saves the shown rows (after filters and sort).

**Generate SQL…:** `INSERT`, `UPDATE` or `DELETE` statements for the selected rows (or all shown rows), with **Copy** and **Open in new tab**. Nothing is run, so it also works on read-only connections.

## 11. JSON

- **Paste JSON into a tab and press Ctrl+Shift+F:** one value per line. Values stay exactly as stored (`655.00` stays `655.00`, long numbers keep every digit). Right-click → **JSON: one line** puts it back on one line. Broken or cut-off JSON is still laid out, with a message giving the line and column of the problem.
- **Double-click a JSON cell:** it opens formatted; **As stored** shows the raw text; **Copy** copies what you see.
- **JSON → columns:** columns holding JSON get a **{}** button on their name. Click it and each key becomes its own column (`payload.UTR`, `payload.UDF20`…) to filter, sort, total, copy and export. Click **{}** again to hide them (editing is off while they are shown).

## 12. Editing data

Results from one table with a primary key are editable when the connection is **not** read-only:

- **F2**, Enter or just typing edits a cell; **Delete** sets NULL; **Esc** cancels.
- **+ Row** adds a row, **− Delete row** marks rows for deletion, **⧉ Duplicate** copies selected rows as new rows (primary key left empty).
- Changes are only written when you click **Save** (in one transaction); the grid then reloads from the database.
- **Read-only** connections show the data but block all changes.

## 13. Compare two connections (LP vs DR)

Run the same query on two connections and see the differences.

- **Pair once:** ✎ Edit a connection → **Compare with → KGFS DR**. The pairing works both ways. Connections without a partner show no button.
- **Compare:** in the tab, put the cursor in a query and click **⇄ Compare with KGFS DR**. If DR isn't connected it connects in the background (no extra tab), uses the same database, and asks `:parameters` once.
- **Result** (⇄ Compare tab):
  - summary: **≠ different · only in LP · only in DR · = same**;
  - changed cells show both values (◀ first connection, ▶ second);
  - rows on one side only are tinted.
  - Rows are matched by `id` automatically, or by a column you choose under **Match rows by**.
  - **Only differences** is on by default; **Copy** pastes the comparison into Excel.
- **Any other connection:** **▾** next to the button, or right-click → *Compare with another connection…*. The choice is remembered.
- **Safe:** only a single `SELECT` / `WITH` query is sent; anything else is refused before running.

## 14. Safety and read-only

- **Read-only connections** (default for PROD / DR names) block INSERT, UPDATE, DELETE and DDL in two ways: Rowlight checks before sending, and the MySQL session itself is set to `READ ONLY`. The **🔒 Read-only** button in the toolbar switches it (with a warning for PROD / DR).
- `UPDATE` / `DELETE` without `WHERE` are underlined and asked about before running.
- Warnings for `JOIN` without `ON` and `SELECT *` on very big tables.
- For production, the strongest protection is a database user that only has `SELECT` rights. Rowlight's read-only mode is a convenience on top of that.

## 15. Security and privacy

| What | How it is stored |
|---|---|
| Passwords | Encrypted with Windows DPAPI (tied to your Windows login), never shown to the window |
| Query history, open tab text, saved queries, `:param` values | Encrypted with Windows DPAPI (`history\*.dat`, `private.dat`) |
| Connections (without passwords), settings | Plain files in `%APPDATA%\Rowlight` |
| CSV / Excel exports | Plain files where you choose |

- The SSH host key of each bastion is checked on every connect (protects against man-in-the-middle).
- The app window is sandboxed with a strict content-security policy, so a value in a result can't run code.
- Not yet: code signing of the installer, and an independent security audit.

## 16. Share with Claude

**✦ Share with Claude** (toolbar) lets Claude (desktop app or Claude Code in VS Code) run **read-only** queries on this connection.

- **Step 1 (once):** add Rowlight to Claude Desktop or Claude Code with the button.
- **Step 2:** **Start sharing** each time you want Claude to use the connection; **Stop sharing** ends it.
- Local only (127.0.0.1), a new secret token each time, read-only on the server too.
- **PROD / DR connections** ask you to tick *"I understand"* first: the rows Claude asks for are sent to Claude (Anthropic) and leave this PC. Check your company's data policy before sharing customer data.

## 17. Settings

- **Auto-LIMIT** for SELECTs (0 = off).
- **Updates:** automatic or manual, **Check for updates now**.
- **Smart features** (each can be switched off; **All off** switches all of them off):
  - clause-aware suggestions;
  - functions;
  - snippets;
  - learning from history;
  - did-you-mean;
  - safety warnings;
  - no `;` needed (blank line);
  - Ctrl+Enter runs the statement under the cursor;
  - `*` after columns means `alias.*`;
  - ask for `:name` values;
  - pasted list → IN list.
- **Theme:** System / Light / Dark (top bar). **Zoom:** A− / A+ or Ctrl+= / Ctrl+− / Ctrl+0.

## 18. Keyboard shortcuts

The most used ones. **F1** shows all of them, with a search box.

| Keys | Action |
|---|---|
| Ctrl+Enter | Run the statement under the cursor (or the selection) |
| Ctrl+Shift+Enter | Run the whole script |
| Ctrl+E / Ctrl+W | New tab / close tab |
| Ctrl+P | Saved queries |
| Ctrl+Shift+F | Format (SQL or JSON) |
| Ctrl+. | Quick fix on an underlined word |
| Ctrl+Space | Suggestions |
| Ctrl+R | Hide / show results |
| Ctrl+B | Hide / show connections panel |
| Ctrl+O / Ctrl+S | Open / save .sql file |
| Alt+drag | Box selection |
| Ctrl+Click | Add a cursor |
| Ctrl+D | Select next occurrence |
| Ctrl+/ | Comment line |
| Ctrl+F / Ctrl+H | Find / replace |
| Ctrl+C / Ctrl+Shift+C | Copy cells / with headers (grid) |
| F2 | Edit a cell (grid) |
| F1 | All shortcuts |

## 19. Files and troubleshooting

- **Data folder:** `%APPDATA%\Rowlight`:
  - `connections.json`, `settings.json`;
  - `history\*.dat` (encrypted);
  - `private.dat` (encrypted);
  - `logs\renderer.log`.
- **If part of the window breaks** you get an error message with **Try again** and **Copy error**; details go to `logs\renderer.log`. Send that file when reporting a problem.
- **"Not connected" / connection lost:** click **Connect** again on the left; open tabs keep their text.
- **Suggestions missing a new table:** click **⟳** on the connection to reload the table list.
