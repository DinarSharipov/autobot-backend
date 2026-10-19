import { describe, expect, it, vi } from 'vitest';

import { CreditType } from '../generated/prisma/client.js';
import { GenerationFundingService } from './generation-funding.service.js';

function service(enabled: boolean) {
  const usage = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn() };
  const wallet = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn() };
  const allowance = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn(), ensure: vi.fn() };
  const config = { get: vi.fn().mockReturnValue(enabled) };
  return {
    funding: new GenerationFundingService(
      config as never,
      usage as never,
      wallet as never,
      allowance as never,
    ),
    usage,
    wallet,
    allowance,
  };
}

describe('GenerationFundingService', () => {
  it('routes reservations to prepaid wallet when enabled', async () => {
    const { funding, usage, wallet } = service(true);
    await funding.reserveText('user-1', 'publication-1');

    expect(wallet.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        creditType: CreditType.TEXT,
        units: 1,
        operationKey: 'publication:publication-1:text-generation:reserve',
      }),
      undefined,
    );
    expect(usage.reserve).not.toHaveBeenCalled();
  });

  it('keeps subscription usage when prepaid mode is disabled', async () => {
    const { funding, usage, wallet } = service(false);
    await funding.commitImage('user-1', 'publication-1');

    expect(usage.commit).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'IMAGE_GENERATION', amount: 1 }),
    );
    expect(wallet.commit).not.toHaveBeenCalled();
  });

  it('routes included revisions to the occurrence allowance in prepaid mode', async () => {
    const { funding, usage, wallet, allowance } = service(true);
    await funding.reserveRevision('user-1', 'publication-1', 'revision-operation');

    expect(allowance.reserve).toHaveBeenCalledWith(
      'user-1',
      'publication-1',
      'revision-operation',
      undefined,
    );
    expect(usage.reserve).not.toHaveBeenCalled();
    expect(wallet.reserve).not.toHaveBeenCalled();
  });
});
