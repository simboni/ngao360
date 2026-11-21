import { processRole, runsWorkers } from '../process-role';

describe('PROCESS_ROLE', () => {
  it('defaults to all (API + workers in one process)', () => {
    expect(processRole({})).toBe('all');
    expect(runsWorkers({})).toBe(true);
  });
  it('api runs no workers; worker does', () => {
    expect(runsWorkers({ PROCESS_ROLE: 'api' })).toBe(false);
    expect(runsWorkers({ PROCESS_ROLE: 'worker' })).toBe(true);
    expect(processRole({ PROCESS_ROLE: ' Worker ' })).toBe('worker');
  });
  it('refuses an unknown role instead of guessing', () => {
    expect(() => processRole({ PROCESS_ROLE: 'both' })).toThrow(/Invalid PROCESS_ROLE/);
  });

  it('QueueModule registers no processors for PROCESS_ROLE=api', () => {
    const prev = process.env.PROCESS_ROLE;
    const prevQ = process.env.QUEUES_ENABLED;
    try {
      process.env.QUEUES_ENABLED = 'true';
      jest.isolateModules(() => {
        process.env.PROCESS_ROLE = 'api';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { QueueModule } = require('../queue.module') as typeof import('../queue.module');
        const names = (QueueModule.register().providers ?? []).map((p) => (p as { name?: string }).name);
        expect(names).toEqual(['OcrQueueService']);
      });
      jest.isolateModules(() => {
        process.env.PROCESS_ROLE = 'worker';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { QueueModule } = require('../queue.module') as typeof import('../queue.module');
        const names = (QueueModule.register().providers ?? []).map((p) => (p as { name?: string }).name);
        expect(names).toEqual(['OcrQueueService', 'OcrProcessor', 'NotificationQueueProcessor']);
      });
    } finally {
      if (prev === undefined) delete process.env.PROCESS_ROLE;
      else process.env.PROCESS_ROLE = prev;
      if (prevQ === undefined) delete process.env.QUEUES_ENABLED;
      else process.env.QUEUES_ENABLED = prevQ;
    }
  });
});
