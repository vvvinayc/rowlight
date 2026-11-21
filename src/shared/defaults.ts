// Defaults shared by main and renderer.

/** New connections whose name contains "prod" or "dr" start in read-only mode. */
export function defaultReadOnlyForName(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('prod') || n.includes('dr');
}

export const DEFAULT_SELECT_LIMIT = 1000;
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
