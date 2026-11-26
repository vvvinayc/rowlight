// Defaults shared by main and renderer.

/** New connections whose name contains "prod" or "dr" start in read-only mode. */
export function defaultReadOnlyForName(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('prod') || n.includes('dr');
}

export const DEFAULT_SELECT_LIMIT = 1000;

/** Smart editor features (Settings → Smart features), all on by default. */
export const SMART_KEYS = ['clauseAware', 'functions', 'snippets', 'history', 'didYouMean', 'safety', 'blankLineSplit', 'runAtCursor', 'fixStar', 'params'] as const;
export const SMART_LABELS: Record<(typeof SMART_KEYS)[number], [title: string, detail: string]> = {
  clauseAware: ['Clause-aware suggestions', 'Different suggestions after SELECT, WHERE, GROUP BY, ORDER BY'],
  functions: ['SQL functions with hints', 'COUNT, DATE_FORMAT, COALESCE… with how to use them'],
  snippets: ['Snippets', 'sel, cnt, dup, grp, top, month, miss… expand into a full query'],
  history: ['Learn from my history', 'Rank tables / columns / joins by use; remember my own joins'],
  didYouMean: ['Did-you-mean fixes', 'One-click fix for a misspelled column or table in an error'],
  safety: ['Safety hints', 'UPDATE/DELETE without WHERE, JOIN without ON, SELECT * on big tables'],
  blankLineSplit: ['Blank line ends a statement', 'No ";" needed between queries separated by an empty line (MySQL). Format adds the ";"'],
  fixStar: ['"*" after columns means alias.*', 'select a.id, * from t a runs as a.id, a.* (MySQL needs the alias)'],
  params: ['Ask for :name values', 'where loan_id = :loan asks for the value when you run it'],
  runAtCursor: ['Ctrl+Enter runs the statement under the cursor', 'Ctrl+Shift+Enter runs the whole script. Off: Ctrl+Enter runs the whole script'],
};
export const DEFAULT_PORTS = { mysql: 3306, mssql: 1433 } as const;

/** Connection colours (shown on the sidebar, tabs and toolbar). Readable in both themes. */
export const CONNECTION_COLORS: Record<string, string> = {
  red: '#e5484d',
  orange: '#f08c2e',
  yellow: '#d4a017',
  green: '#30a46c',
  blue: '#3e7bfa',
  purple: '#8e4ec6',
  gray: '#8b8d98',
};

export function connectionColor(name?: string): string | undefined {
  return name ? CONNECTION_COLORS[name] : undefined;
}

/** New prod / DR connections start red, like the read-only default. */
export function defaultColorForName(name: string): string | undefined {
  return defaultReadOnlyForName(name) ? 'red' : undefined;
}
