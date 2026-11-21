/**
 * ClamAV daemon adapter speaking the INSTREAM protocol over TCP. Owner: platform-infra.
 *
 *   -> "zINSTREAM\0", then chunks of <uint32 big-endian length><bytes>, then <0 0 0 0>
 *   <- "stream: OK\0" | "stream: <Signature> FOUND\0" | "<message> ERROR\0"
 *
 * Host, port and timeout come from the environment (MALWARE_SCANNER=clamd, CLAMD_HOST, CLAMD_PORT,
 * CLAMD_TIMEOUT_MS). Never throws: a refused connection, a timeout, a size-limit refusal or any
 * reply we do not understand is ERROR (fail closed; the scan job retries later), never CLEAN.
 */
import { Logger } from '@nestjs/common';
import { Socket } from 'node:net';
import type { MalwareScanner, ScanVerdict } from './malware-scanner';

export interface ClamdOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** Bytes per INSTREAM chunk (must stay below clamd's StreamMaxLength). */
  chunkBytes?: number;
}

/** Parse one clamd reply line. Exported for tests. */
export function parseClamdReply(reply: string): ScanVerdict {
  const line = reply.replace(/\0/g, '').trim();
  if (/^stream: OK$/.test(line)) return { status: 'CLEAN', engine: 'clamd' };
  const found = /^stream: (.+) FOUND$/.exec(line);
  if (found) return { status: 'INFECTED', engine: 'clamd', signature: found[1]!.slice(0, 200) };
  return { status: 'ERROR', engine: 'clamd', error: line.endsWith('ERROR') ? `clamd: ${line.slice(0, 160)}` : 'clamd: unexpected reply' };
}

export class ClamdMalwareScanner implements MalwareScanner {
  readonly name = 'clamd';
  private readonly logger = new Logger(ClamdMalwareScanner.name);

  constructor(private readonly options: ClamdOptions) {}

  isConfigured(): boolean {
    return true;
  }

  scan(bytes: Buffer, context: { tenantId: string; storedFileId: string }): Promise<ScanVerdict> {
    const chunk = this.options.chunkBytes ?? 64 * 1024;
    return new Promise<ScanVerdict>((resolve) => {
      const socket = new Socket();
      const parts: Buffer[] = [];
      let done = false;
      const finish = (v: ScanVerdict) => {
        if (done) return;
        done = true;
        socket.destroy();
        if (v.status === 'ERROR') this.logger.warn(`Scan of file ${context.storedFileId} failed: ${v.error}`);
        resolve(v);
      };
      socket.setTimeout(this.options.timeoutMs, () => finish({ status: 'ERROR', engine: 'clamd', error: 'clamd timed out' }));
      socket.once('error', (err: NodeJS.ErrnoException) => finish({ status: 'ERROR', engine: 'clamd', error: `clamd unreachable (${err.code ?? 'error'})` }));
      socket.on('data', (d: Buffer) => {
        parts.push(d);
        const all = Buffer.concat(parts);
        if (all.includes(0)) finish(parseClamdReply(all.toString('utf8')));
      });
      socket.once('end', () => finish(parts.length ? parseClamdReply(Buffer.concat(parts).toString('utf8')) : { status: 'ERROR', engine: 'clamd', error: 'clamd closed the connection' }));
      socket.connect(this.options.port, this.options.host, () => {
        socket.write('zINSTREAM\0');
        for (let off = 0; off < bytes.length; off += chunk) {
          const piece = bytes.subarray(off, Math.min(off + chunk, bytes.length));
          const len = Buffer.alloc(4);
          len.writeUInt32BE(piece.length, 0);
          socket.write(len);
          socket.write(piece);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }

  /** PING / PONG health check. */
  ping(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new Socket();
      let reply = '';
      const end = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(this.options.timeoutMs, () => end(false));
      socket.once('error', () => end(false));
      socket.on('data', (d: Buffer) => {
        reply += d.toString('utf8');
        if (reply.includes('\0')) end(reply.replace(/\0/g, '').trim() === 'PONG');
      });
      socket.connect(this.options.port, this.options.host, () => socket.write('zPING\0'));
    });
  }
}
