// MCP tool definitions shared by the Rowlight share server (mcpServer.ts) and the
// Claude Desktop bridge (src/bridge/bridge.ts). No Electron / Node imports here.

export const ROW_CAP = 500;
export const TIMEOUT_MS = 15_000;
export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_VERSION = '0.3.0';

export const TOOLS = [
  {
    name: 'list_tables',
    description: 'List the tables and views in a database. Without "database", uses the default database of the connection; if there is none, lists the databases.',
    inputSchema: { type: 'object', properties: { database: { type: 'string', description: 'Database name (optional)' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'describe_table',
    description: 'Show the columns of a table: name, type, nullability and primary key.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name (SQL Server: schema.table)' },
        database: { type: 'string', description: 'Database name (optional)' },
      },
      required: ['table'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'query',
    description: `Run a READ-ONLY SQL query (SELECT / SHOW / DESCRIBE / EXPLAIN). Writes and DDL are rejected. ` +
      `At most ${ROW_CAP} rows are returned and the query is cancelled after ${TIMEOUT_MS / 1000} seconds; add LIMIT / WHERE for big tables.`,
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The SQL to run' },
        database: { type: 'string', description: 'Database to run it in (optional)' },
      },
      required: ['sql'],
    },
    annotations: { readOnlyHint: true },
  },
];

export function pickProtocolVersion(asked: unknown): string {
  return typeof asked === 'string' && SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[1];
}

/** Server name used in Claude configs, e.g. "rowlight-prod-db". */
export function mcpServerName(connectionName: string): string {
  return 'rowlight-' + (connectionName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'db');
}
