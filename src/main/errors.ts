// Turns low-level errors (ssh2, mysql2, tedious, net) into clear messages for the user.

import type { AppError, ErrorKind } from '../shared/types';

export class AppFailure extends Error {
  constructor(public kind: ErrorKind, message: string, public detail?: string) {
    super(message);
  }
}

const NETWORK_CODES = ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND'];

function describeNetwork(code: string, what: string, where: string): string {
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `${what} host name "${where}" could not be resolved (DNS). Check the host name / VPN.`;
    case 'ECONNREFUSED':
      return `${what} at ${where} refused the connection. Check the port and that the service is running.`;
    case 'ETIMEDOUT':
      return `${what} at ${where} did not answer (timeout). Check host, port, VPN and firewall.`;
    default:
      return `${what} at ${where} is unreachable (${code}).`;
  }
}

/** Errors raised while connecting to / authenticating with the SSH bastion. */
export function classifySshError(err: any, where: string): AppFailure {
  if (err instanceof AppFailure) return err;
  const msg = String(err?.message ?? err);
  if (err?.level === 'client-authentication' || /All configured authentication methods failed/i.test(msg)) {
    return new AppFailure('ssh-auth', 'SSH login failed: wrong SSH user name, password or key (the bastion rejected it).', msg);
  }
  if (/passphrase|Cannot parse privateKey|Unsupported key format|encrypted private key/i.test(msg)) {
    return new AppFailure('ssh-key', 'Could not read the SSH private key. If the key is encrypted, enter its passphrase.', msg);
  }
  if (err?.code && NETWORK_CODES.includes(err.code)) {
    return new AppFailure('ssh-unreachable', describeNetwork(err.code, 'SSH bastion', where), msg);
  }
  if (/Timed out while waiting for handshake/i.test(msg)) {
    return new AppFailure('ssh-unreachable', `SSH bastion at ${where} did not complete the handshake in time. Check host, port, VPN and firewall.`, msg);
  }
  return new AppFailure('ssh-unreachable', `SSH connection to ${where} failed: ${msg}`, msg);
}

/** Errors raised by the DB driver (connect or query). */
export function classifyDbError(err: any, where: string): AppFailure {
  if (err instanceof AppFailure) return err;
  const msg = String(err?.message ?? err);
  const code = err?.code as string | undefined;
  // MySQL
  if (code === 'ER_ACCESS_DENIED_ERROR' || err?.errno === 1045) {
    return new AppFailure('db-auth', 'Database login failed: wrong DB user name or password.', msg);
  }
  if (code === 'ER_DBACCESS_DENIED_ERROR' || err?.errno === 1044) {
    return new AppFailure('db-auth', 'The DB user is not allowed to access this database.', msg);
  }
  if (code === 'ER_BAD_DB_ERROR' || err?.errno === 1049) {
    return new AppFailure('db-unknown-database', 'The database name does not exist on the server.', msg);
  }
  if (code === 'ER_QUERY_INTERRUPTED' || err?.errno === 1317 || code === 'ECANCEL') {
    return new AppFailure('cancelled', 'Query cancelled.', msg);
  }
  // SQL Server (tedious)
  if (code === 'ELOGIN') {
    if (/Cannot open database/i.test(msg)) return new AppFailure('db-unknown-database', 'The database does not exist or the login cannot open it.', msg);
    return new AppFailure('db-auth', 'Database login failed: wrong DB user name or password.', msg);
  }
  if (code && NETWORK_CODES.includes(code)) {
    return new AppFailure('db-unreachable', describeNetwork(code, 'Database server', where), msg);
  }
  if (code === 'ESOCKET' || code === 'ETIMEOUT' || code === 'PROTOCOL_CONNECTION_LOST') {
    return new AppFailure('db-unreachable', `Lost or could not open the connection to the database at ${where}.`, msg);
  }
  return new AppFailure('db-error', msg, code);
}

export function toAppError(err: any): AppError {
  if (err instanceof AppFailure) return { kind: err.kind, message: err.message, detail: err.detail };
  return { kind: 'unknown', message: String(err?.message ?? err) };
}
