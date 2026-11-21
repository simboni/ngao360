import { Prisma } from '@ngao360/db';
import { AllExceptionsFilter } from '../all-exceptions.filter';

const known = (code: string, message: string) => new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });

describe('AllExceptionsFilter under database overload (load test)', () => {
  const f = new AllExceptionsFilter();

  it('answers 503 RATE_LIMITED when the pool or a new transaction times out (nothing was written)', () => {
    expect(f.toApiError(known('P2024', 'Timed out fetching a new connection from the connection pool.'))).toMatchObject({ statusCode: 503, code: 'RATE_LIMITED' });
    expect(f.toApiError(known('P2028', 'Transaction API error: Unable to start a transaction in the given time.'))).toMatchObject({ statusCode: 503, code: 'RATE_LIMITED' });
  });

  it('keeps 500 for a transaction that expired while running (it may have done work)', () => {
    expect(f.toApiError(known('P2028', 'Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.'))).toMatchObject({ statusCode: 500 });
  });

  it('sets Retry-After on a 503', () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v), status: () => res, json: () => res };
    f.catch(known('P2024', 'Timed out fetching a new connection'), { switchToHttp: () => ({ getResponse: () => res }) } as never);
    expect(headers['Retry-After']).toBe('2');
  });
});
