// SSH tunnel built on the "ssh2" library (pure JavaScript, no ssh.exe / SSH_ASKPASS).
//
// Flow: connect + authenticate to the bastion -> check the bastion can reach the DB host ->
// open a local TCP listener on 127.0.0.1:<random port> that forwards every socket through
// the SSH connection to dbHost:dbPort. The DB driver then simply connects to 127.0.0.1:<port>.

import { Client, type ConnectConfig } from 'ssh2';
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AppFailure, classifySshError } from './errors';

export interface TunnelOptions {
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key';
  password?: string;
  keyPath?: string;
  passphrase?: string;
  /** Previously trusted host key fingerprint (SHA256:...). */
  knownFingerprint?: string;
  dstHost: string;
  dstPort: number;
  /** Called for keyboard-interactive prompts that are not simply "Password:" (e.g. OTP codes). */
  askPrompts: (instructions: string, prompts: { prompt: string; echo: boolean }[]) => Promise<string[] | null>;
  /** Called when the tunnel drops after it was established. */
  onClose: (reason: string) => void;
}

export interface Tunnel {
  localPort: number;
  fingerprint: string;
  close(): void;
}

/** A keyboard-interactive prompt that asks for the account password (not a one-time code). */
export function isPasswordPrompt(prompt: string, echo: boolean): boolean {
  const p = prompt.trim();
  if (/(otp|one[- ]?time|verification|authenticator|token|2fa|mfa|totp|pin\b|code\b)/i.test(p) && !/pass(word|phrase)/i.test(p)) return false;
  if (/pass(word|phrase|wd)?/i.test(p)) return true; // "Password:", "Password for x@y:", "(x@y) Password:", "Passphrase"
  return !echo && p.length > 0 && !/[?]$/.test(p) && /:\s*$/.test(p) && !/(code|token|otp)/i.test(p); // other hidden "…:" prompts
}

function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

export async function openTunnel(opts: TunnelOptions): Promise<Tunnel> {
  const where = `${opts.host}:${opts.port}`;
  const client = new Client();
  let fingerprint = '';
  let hostKeyMismatch = false;

  const config: ConnectConfig = {
    host: opts.host,
    port: opts.port,
    username: opts.user,
    readyTimeout: 20000,
    keepaliveInterval: 60000, // send keep-alive every 60s
    keepaliveCountMax: 3,
    tryKeyboard: true, // allow keyboard-interactive auth (many bastions use it instead of "password")
    hostVerifier: (key: Buffer) => {
      fingerprint = fingerprintOf(key);
      if (opts.knownFingerprint && opts.knownFingerprint !== fingerprint) {
        hostKeyMismatch = true;
        return false;
      }
      return true;
    },
  };

  if (opts.auth === 'password') {
    config.password = opts.password ?? '';
  } else {
    if (!opts.keyPath) throw new AppFailure('ssh-key', 'No SSH private key file selected.');
    try {
      config.privateKey = fs.readFileSync(opts.keyPath);
    } catch (e: any) {
      throw new AppFailure('ssh-key', `Cannot read SSH key file "${opts.keyPath}".`, e?.message);
    }
    if (opts.passphrase) config.passphrase = opts.passphrase;
  }

  // keyboard-interactive: answer "password"-style prompts with the saved password,
  // and ask the user for anything else (OTP / verification code).
  // Bastions word the password question in many ways ("Password:", "Password for user@host:",
  // "(user@host) Password:", "Enter passphrase:", …), so on the FIRST round any hidden prompt that is
  // not clearly asking for a one-time code gets the saved password. Codes (OTP / verification / token)
  // and every later round (= the server asks again, so the password was rejected or it wants more)
  // are shown to the user.
  let kiRound = 0;
  client.on('keyboard-interactive', (_name, instructions, _lang, prompts, finish) => {
    kiRound++;
    if (prompts.length === 0) return finish([]);
    const answers: (string | undefined)[] = prompts.map((p) =>
      kiRound === 1 && opts.password && isPasswordPrompt(p.prompt, !!p.echo) ? opts.password : undefined);
    const toAsk = prompts.map((p, i) => ({ i, prompt: p.prompt, echo: !!p.echo })).filter((x) => answers[x.i] === undefined);
    if (!toAsk.length) return finish(answers as string[]);
    const askedPasswordAgain = kiRound > 1 && !!opts.password && prompts.some((p) => isPasswordPrompt(p.prompt, !!p.echo));
    const note = askedPasswordAgain ? 'The bastion asked for the password again, so the saved SSH password may be wrong or expired.\n' : '';
    opts
      .askPrompts(note + (instructions ?? ''), toAsk.map(({ prompt, echo }) => ({ prompt, echo })))
      .then((typed) => {
        toAsk.forEach((x, k) => { answers[x.i] = typed?.[k] ?? ''; });
        finish(answers.map((a) => a ?? ''));
      })
      .catch(() => finish(prompts.map(() => '')));
  });

  // 1. Connect + authenticate
  await new Promise<void>((resolve, reject) => {
    const onError = (err: any) => {
      client.removeListener('ready', onReady);
      if (hostKeyMismatch) {
        reject(new AppFailure('ssh-hostkey',
          `The SSH host key of ${where} has CHANGED (now ${fingerprint}). This can mean the server was rebuilt, or a man-in-the-middle. ` +
          'If you trust the change, edit the connection and click "Forget host key".'));
      } else {
        reject(classifySshError(err, where));
      }
    };
    const onReady = () => {
      client.removeListener('error', onError);
      resolve();
    };
    client.once('ready', onReady);
    client.once('error', onError);
    try {
      client.connect(config);
    } catch (e) {
      onError(e);
    }
  });

  let closed = false;
  let server: net.Server | undefined;

  // Login check only (testing an SSH profile): no forwarding.
  if (!opts.dstHost) {
    client.end();
    return { localPort: 0, fingerprint, close() {} };
  }
  client.on('error', (err) => { if (!closed) opts.onClose(`SSH error: ${err.message}`); });
  client.on('close', () => { if (!closed) { closed = true; server?.close(); opts.onClose('SSH connection to the bastion was closed.'); } });

  // 2. Check that the bastion can reach the database host.
  await new Promise<void>((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, opts.dstHost, opts.dstPort, (err, stream) => {
      if (err) {
        client.end();
        closed = true;
        return reject(new AppFailure('ssh-forward',
          `SSH login OK, but the bastion could not open a connection to the database at ${opts.dstHost}:${opts.dstPort} ` +
          `(${err.message}). Check the DB host/port as seen from the bastion.`, err.message));
      }
      stream.end();
      resolve();
    });
  });

  // 3. Local listener on 127.0.0.1 only.
  server = net.createServer((socket) => {
    client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, opts.dstHost, opts.dstPort, (err, stream) => {
      if (err) { socket.destroy(err); return; }
      socket.pipe(stream).pipe(socket);
      const done = () => { socket.destroy(); stream.destroy(); };
      socket.on('error', done);
      stream.on('error', done);
      socket.on('close', done);
      stream.on('close', done);
    });
  });
  const localPort = await new Promise<number>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => resolve((server!.address() as net.AddressInfo).port));
  });

  return {
    localPort,
    fingerprint,
    close() {
      if (closed) return;
      closed = true;
      server?.close();
      client.end();
    },
  };
}
