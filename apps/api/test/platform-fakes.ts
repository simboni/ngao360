/**
 * In-process fakes for the platform vendor adapters (no external hosts are ever contacted):
 * an SMTP server, a generic HTTP server (Africa's Talking, captcha verify endpoints) and a clamd
 * daemon speaking the INSTREAM protocol that flags the EICAR test string. Synthetic data only.
 */
import { EICAR_TEST_STRING } from '@ngao360/shared';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo, createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { SMTPServer } from 'smtp-server';

export interface FakeSmtp {
  port: number;
  messages: Array<{ from: string; to: string[]; raw: string }>;
  /** Next RCPT TO is refused with this SMTP code (e.g. 550), once. */
  refuseNextRecipient: (code: number) => void;
  close: () => Promise<void>;
}

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const messages: FakeSmtp['messages'] = [];
  let refuse: number | null = null;
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onRcptTo(address, _session, cb) {
      if (refuse) {
        const code = refuse;
        refuse = null;
        const err = new Error('Mailbox unavailable') as Error & { responseCode: number };
        err.responseCode = code;
        return cb(err);
      }
      cb();
      void address;
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        messages.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        cb();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = ((server as unknown as { server: Server }).server.address() as AddressInfo).port;
  return {
    port,
    messages,
    refuseNextRecipient: (code) => (refuse = code),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface FakeHttpRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface FakeHttp {
  url: string;
  requests: FakeHttpRequest[];
  /** Replace the handler (status, JSON body, optional delay in ms). */
  respond: (fn: (req: FakeHttpRequest) => { status: number; json?: unknown; body?: string; delayMs?: number }) => void;
  close: () => Promise<void>;
}

export async function startFakeHttp(): Promise<FakeHttp> {
  const requests: FakeHttpRequest[] = [];
  let handler: (req: FakeHttpRequest) => { status: number; json?: unknown; body?: string; delayMs?: number } = () => ({ status: 200, json: {} });
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const r: FakeHttpRequest = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(r);
      const out = handler(r);
      const send = () => {
        if (res.destroyed) return;
        res.statusCode = out.status;
        res.setHeader('content-type', 'application/json');
        res.end(out.body !== undefined ? out.body : JSON.stringify(out.json ?? {}));
      };
      if (out.delayMs) setTimeout(send, out.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respond: (fn) => (handler = fn),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export interface FakeClamd {
  port: number;
  /** Number of INSTREAM scans answered. */
  scans: () => number;
  /** 'ok' (normal), 'hang' (never answers), 'error' (answers with an ERROR line). */
  mode: (m: 'ok' | 'hang' | 'error' | 'exceeds') => void;
  close: () => Promise<void>;
}

/**
 * Minimal clamd: `zINSTREAM\0` then <uint32 len><bytes>… <0000>, answers
 * `stream: OK\0` or `stream: Eicar-Test-Signature FOUND\0`; `zPING\0` answers `PONG\0`.
 */
export async function startFakeClamd(): Promise<FakeClamd> {
  let count = 0;
  let mode: 'ok' | 'hang' | 'error' | 'exceeds' = 'ok';
  const sockets = new Set<Socket>();
  const server: TcpServer = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    let command: string | null = null;
    const data: Buffer[] = [];
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (command === null) {
        const z = buf.indexOf(0);
        if (z < 0) return;
        command = buf.subarray(0, z).toString('utf8');
        buf = buf.subarray(z + 1);
        if (command === 'zPING') {
          socket.end('PONG\0');
          return;
        }
      }
      if (command !== 'zINSTREAM') return;
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          count += 1;
          if (mode === 'hang') return;
          if (mode === 'error') {
            socket.end('INSTREAM size limit exceeded. ERROR\0');
            return;
          }
          if (mode === 'exceeds') {
            // clamd with AlertExceedsMax yes: content beyond a scan limit is reported, not passed.
            socket.end('stream: Heuristics.Limits.Exceeded.MaxScanSize FOUND\0');
            return;
          }
          const all = Buffer.concat(data).toString('latin1');
          socket.end(all.includes(EICAR_TEST_STRING) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buf.length < 4 + len) return;
        data.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    scans: () => count,
    mode: (m) => (mode = m),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port with nothing listening (connection refused). */
export async function closedPort(): Promise<number> {
  const s = createTcpServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/**
 * Record a CLEAN verdict for a stored file, as the malware-scanning job does after a clean clamd
 * answer. For suites that exercise workflows needing CLEAN files without running a scanner.
 */
export async function markScannedClean(owner: { storedFile: { update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown> } }, fileId: string): Promise<void> {
  await owner.storedFile.update({ where: { id: fileId }, data: { malwareScanStatus: 'CLEAN', scanEngine: 'test-scanner', scannedAt: new Date() } });
}
