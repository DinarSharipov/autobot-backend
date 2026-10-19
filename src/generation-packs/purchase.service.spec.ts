/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it, vi } from 'vitest';

import { PurchaseService } from './purchase.service.js';

function setup() {
  const transaction = {
    generationPack: { findUnique: vi.fn() },
    purchaseOrder: { create: vi.fn() },
  };
  const execute = async (input: {
    handler: (database: typeof transaction) => Promise<unknown>;
  }): Promise<unknown> => input.handler(transaction);
  const idempotency = {
    digest: vi.fn().mockReturnValue('request-hash'),
    execute: vi.fn(execute),
  };
  const prisma = {};
  return {
    transaction,
    idempotency,
    service: new PurchaseService(prisma as never, idempotency as never),
  };
}

describe('PurchaseService', () => {
  it('snapshots the active pack price and quantity in a pending order', async () => {
    const { transaction, idempotency, service } = setup();
    transaction.generationPack.findUnique.mockResolvedValue({
      id: 'pack-1',
      code: 'text-20',
      creditType: 'TEXT',
      units: 20,
      priceMinor: 9900,
      currency: 'RUB',
      version: 4,
      isActive: true,
    });
    transaction.purchaseOrder.create.mockResolvedValue({
      id: 'order-1',
      status: 'PENDING',
      creditType: 'TEXT',
      units: 20,
      priceMinor: 9900,
      currency: 'RUB',
      packVersion: 4,
      paymentUrl: null,
      expiresAt: null,
      paidAt: null,
      createdAt: new Date('2026-10-19T08:00:00.000Z'),
      pack: { code: 'text-20' },
    });

    const result = await service.create('user-1', ' text-20 ', '1234567890abcdef');

    expect(result).toMatchObject({
      id: 'order-1',
      packCode: 'text-20',
      units: 20,
      priceMinor: 9900,
      packVersion: 4,
      status: 'PENDING',
    });
    expect(idempotency.digest).toHaveBeenCalledWith({ packCode: 'text-20' });
    expect(transaction.purchaseOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          packId: 'pack-1',
          units: 20,
          priceMinor: 9900,
          packVersion: 4,
        }),
      }),
    );
  });

  it('does not create an order for an inactive pack', async () => {
    const { transaction, service } = setup();
    transaction.generationPack.findUnique.mockResolvedValue({ isActive: false });

    await expect(
      service.create('user-1', 'retired-pack', '1234567890abcdef'),
    ).rejects.toMatchObject({
      response: { code: 'GENERATION_PACK_NOT_FOUND' },
    });
    expect(transaction.purchaseOrder.create).not.toHaveBeenCalled();
  });
});
