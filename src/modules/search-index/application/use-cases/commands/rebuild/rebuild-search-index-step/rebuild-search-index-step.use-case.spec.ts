import { describe, expect, it, vi } from 'vitest';

import { SearchAuthorityReadError } from '../../../../../domain/errors/authority/search-authority-read.error.js';
import { SearchRebuildPromotionError } from '../../../../../domain/errors/rebuild/search-rebuild-promotion.error.js';
import type { SearchRebuildRuntime } from '../../../../models/rebuild/search-rebuild-runtime.model.js';
import { RebuildSearchIndexStep } from './rebuild-search-index-step.use-case.js';

const broker = {
  stream: 'EVENTS',
  createdAt: '2026-11-20T00:00:00Z',
  firstSequence: 1,
  lastSequence: 1,
  retainedGapCount: 0,
  consumers: [],
};
const generation = {
  id: 'g',
  indexUid: 'index',
  engineCreatedAt: 'identity',
  status: 'building' as const,
  brokerAtStart: broker,
};
const input = {
  generationId: 'candidate',
  claimToken: 'token',
  now: new Date('2026-11-20T00:02:00Z'),
  claimDeadline: new Date('2026-11-20T00:03:00Z'),
  serveActive: false,
};

function setup(overrides: Partial<SearchRebuildRuntime> = {}) {
  const state: SearchRebuildRuntime = {
    active: null,
    building: null,
    activeQueueStuck: false,
    buildingHasExpiredIntent: false,
    pendingRefreshes: false,
    ...overrides,
  };
  const runtime = { readState: vi.fn().mockResolvedValue(state) };
  const engine = {
    create: vi.fn().mockResolvedValue('identity'),
    readIdentity: vi.fn().mockResolvedValue('identity'),
  };
  const progress = { read: vi.fn().mockResolvedValue(broker) };
  const register = { execute: vi.fn().mockResolvedValue({ generation, newlyRegistered: true }) };
  const bind = { execute: vi.fn().mockResolvedValue(undefined) };
  const abandon = { execute: vi.fn().mockResolvedValue(undefined) };
  const next = { execute: vi.fn().mockResolvedValue(null) };
  const page = { execute: vi.fn().mockResolvedValue('progressed') };
  const refresh = { execute: vi.fn().mockResolvedValue('idle') };
  const promote = { execute: vi.fn().mockResolvedValue(undefined) };
  const deferCheckpoint = vi.fn().mockResolvedValue(undefined);
  const command = new RebuildSearchIndexStep(
    runtime,
    engine,
    progress,
    register,
    bind,
    abandon,
    next,
    page,
    refresh,
    promote,
    {
      run: (work) =>
        work({
          deferCheckpoint,
          claimExportPage: vi.fn(),
          recordExportPage: vi.fn(),
          recordRosterPage: vi.fn(),
        }),
    },
  );
  return {
    command,
    engine,
    progress,
    register,
    bind,
    abandon,
    next,
    page,
    refresh,
    promote,
    deferCheckpoint,
  };
}

describe('RebuildSearchIndexStep', () => {
  it('starts a new candidate after a confirmed active broker identity change', async () => {
    const active = { ...generation, status: 'active' as const };
    const { command, progress, register } = setup({ active });
    const changed = { ...broker, createdAt: '2026-11-21T00:00:00Z' };
    progress.read.mockResolvedValueOnce(changed);
    await expect(command.execute({ ...input, checkActiveBroker: true })).resolves.toBe('created');
    expect(register.execute).toHaveBeenCalledWith({
      generationId: 'candidate',
      brokerAtStart: changed,
    });
    expect(progress.read).toHaveBeenCalledOnce();
  });

  it('detects a replaced exact durable and ignores ordinary retained sequence advancement', async () => {
    const durable = {
      handler: 'search-task',
      createdAt: '2026-11-20T00:00:00Z',
      deliveredSequence: 1,
      ackFloorSequence: 1,
      pending: 0,
      ackPending: 0,
    };
    const baseline = { ...broker, consumers: [durable] };
    const active = { ...generation, status: 'active' as const, brokerAtStart: baseline };
    const { command, progress, register } = setup({ active });
    progress.read.mockResolvedValueOnce({ ...baseline, firstSequence: 20, lastSequence: 40 });
    await expect(command.execute({ ...input, checkActiveBroker: true })).resolves.toBe('idle');
    expect(register.execute).not.toHaveBeenCalled();
    progress.read.mockResolvedValueOnce({
      ...baseline,
      consumers: [{ ...durable, createdAt: '2026-11-21T00:00:00Z' }],
    });
    await expect(command.execute({ ...input, checkActiveBroker: true })).resolves.toBe('created');
    expect(register.execute).toHaveBeenCalledOnce();
  });

  it('preserves the active generation when broker evidence is temporarily unavailable', async () => {
    const active = { ...generation, status: 'active' as const };
    const { command, progress, register, abandon } = setup({ active });
    progress.read.mockResolvedValueOnce(null);
    await expect(command.execute({ ...input, checkActiveBroker: true })).resolves.toBe('idle');
    expect(register.execute).not.toHaveBeenCalled();
    expect(abandon.execute).not.toHaveBeenCalled();
  });
  it('abandons a permanently invalidated generation and preserves temporarily unready candidates', async () => {
    const { command, promote, abandon } = setup({ building: { generation, updatedAt: input.now } });
    const notReady = new SearchRebuildPromotionError('Not ready');
    promote.execute.mockRejectedValueOnce(notReady);
    await expect(command.execute(input)).rejects.toBe(notReady);
    expect(abandon.execute).not.toHaveBeenCalled();
    const unavailable = new Error('Broker unavailable');
    promote.execute.mockRejectedValueOnce(unavailable);
    await expect(command.execute(input)).rejects.toBe(unavailable);
    expect(abandon.execute).not.toHaveBeenCalled();
    promote.execute.mockRejectedValueOnce(
      new SearchRebuildPromotionError('Stream replaced', 'invalidated'),
    );
    await expect(command.execute(input)).resolves.toBe('abandoned');
    expect(abandon.execute).toHaveBeenCalledOnce();
    expect(abandon.execute).toHaveBeenCalledWith({ generationId: 'g' });
  });
  it('abandons an invalid retained source cursor and preserves the candidate on transient failure', async () => {
    const { command, next, page, abandon, deferCheckpoint } = setup({
      building: { generation, updatedAt: input.now },
    });
    next.execute.mockResolvedValue({
      source: 'space',
      organizationId: 'tenant',
      cursor: 'old-cursor',
      inFlightDeadline: null,
      deferred: false,
    });
    page.execute.mockRejectedValueOnce(new SearchAuthorityReadError('unavailable'));
    await expect(command.execute(input)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(abandon.execute).not.toHaveBeenCalled();
    expect(deferCheckpoint).toHaveBeenCalledWith(
      'g',
      expect.objectContaining({ cursor: 'old-cursor' }),
      expect.any(Date),
    );
    page.execute.mockRejectedValueOnce(new SearchAuthorityReadError('invalid-request'));
    await expect(command.execute(input)).resolves.toBe('abandoned');
    expect(abandon.execute).toHaveBeenCalledOnce();
    expect(abandon.execute).toHaveBeenCalledWith({ generationId: 'g' });
  });

  it('waits for an unfinished deferred export without invoking promotion', async () => {
    const { command, next, page, promote } = setup({
      building: { generation, updatedAt: input.now },
    });
    next.execute.mockResolvedValue({
      source: 'document',
      organizationId: 'tenant',
      cursor: null,
      inFlightDeadline: null,
      deferred: true,
    });

    await expect(command.execute(input)).resolves.toBe('waiting');
    expect(page.execute).not.toHaveBeenCalled();
    expect(promote.execute).not.toHaveBeenCalled();
  });

  it('preserves the candidate when the first page is rejected', async () => {
    const { command, next, page, abandon } = setup({
      building: { generation, updatedAt: input.now },
    });
    next.execute.mockResolvedValue({
      source: 'space',
      organizationId: 'tenant',
      cursor: null,
      inFlightDeadline: null,
      deferred: false,
    });
    page.execute.mockRejectedValueOnce(new SearchAuthorityReadError('invalid-request'));
    await expect(command.execute(input)).rejects.toMatchObject({ reason: 'invalid-request' });
    expect(abandon.execute).not.toHaveBeenCalled();
  });
  it('creates and binds only the registered winner after broker evidence', async () => {
    const { command, engine, bind, register } = setup();
    await expect(command.execute(input)).resolves.toBe('created');
    expect(register.execute).toHaveBeenCalledWith({
      generationId: 'candidate',
      brokerAtStart: broker,
    });
    expect(engine.create).toHaveBeenCalledWith('index', undefined);
    expect(bind.execute).toHaveBeenCalledWith({ generationId: 'g', engineCreatedAt: 'identity' });
  });

  it('does not submit physical creation after losing registration', async () => {
    const { command, engine, register } = setup();
    register.execute.mockResolvedValueOnce({ generation, newlyRegistered: false });
    await expect(command.execute(input)).resolves.toBe('waiting');
    expect(engine.create).not.toHaveBeenCalled();
  });

  it('abandons expired unbound and uncertain write generations', async () => {
    const state = {
      building: {
        generation: { ...generation, engineCreatedAt: null },
        updatedAt: new Date('2026-11-20T00:00:00Z'),
      },
    };
    const { command, abandon, engine } = setup(state);
    await expect(command.execute(input)).resolves.toBe('abandoned');
    expect(abandon.execute).toHaveBeenCalledWith({ generationId: 'g' });
    expect(engine.create).not.toHaveBeenCalled();
    const expired = setup({
      building: { generation, updatedAt: input.now },
      buildingHasExpiredIntent: true,
    });
    await expect(expired.command.execute(input)).resolves.toBe('abandoned');
  });

  it('abandons a definitely missing candidate while propagating transient engine failure', async () => {
    const missing = setup({ building: { generation, updatedAt: input.now } });
    missing.engine.readIdentity.mockResolvedValueOnce(null);
    await expect(missing.command.execute(input)).resolves.toBe('abandoned');
    const disconnected = setup({ building: { generation, updatedAt: input.now } });
    disconnected.engine.readIdentity.mockRejectedValueOnce(new Error('disconnected'));
    await expect(disconnected.command.execute(input)).rejects.toThrow('disconnected');
    expect(disconnected.abandon.execute).not.toHaveBeenCalled();
  });

  it('exports first, drains refreshes, and promotes only with broker evidence', async () => {
    const { command, next, page, refresh, promote } = setup({
      building: { generation, updatedAt: input.now },
    });
    next.execute.mockResolvedValueOnce({
      source: 'space',
      organizationId: 'tenant',
      cursor: null,
      inFlightDeadline: null,
      deferred: false,
    });
    await expect(command.execute(input)).resolves.toBe('progressed');
    expect(page.execute).toHaveBeenCalledOnce();
    expect(refresh.execute).not.toHaveBeenCalled();
    refresh.execute.mockResolvedValueOnce('applied');
    await expect(command.execute(input)).resolves.toBe('progressed');
    expect(promote.execute).not.toHaveBeenCalled();
    await expect(command.execute(input)).resolves.toBe('promoted');
    expect(promote.execute).toHaveBeenCalledWith({
      generationId: 'g',
      engineCreatedAt: 'identity',
      broker,
    });
  });

  it('waits on unresolved cascade and permits an active refresh turn during rebuild', async () => {
    const state = {
      building: { generation, updatedAt: input.now },
      active: { ...generation, id: 'active', status: 'active' as const },
      pendingRefreshes: true,
    };
    const { command, refresh, promote, next } = setup(state);
    await expect(command.execute(input)).resolves.toBe('waiting');
    expect(promote.execute).not.toHaveBeenCalled();
    refresh.execute.mockResolvedValueOnce('applied');
    next.execute.mockClear();
    await expect(command.execute({ ...input, serveActive: true })).resolves.toBe('progressed');
    expect(next.execute).not.toHaveBeenCalled();
  });
});
