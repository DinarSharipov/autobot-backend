/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it, vi } from 'vitest';

import { CreditType, ReservationStatus } from '../generated/prisma/client.js';
import { WalletService } from './wallet.service.js';

function transaction() {
  return {
    generationReservation: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    generationWallet: { upsert: vi.fn(), update: vi.fn() },
    creditLedgerEntry: { create: vi.fn().mockResolvedValue({}), findUnique: vi.fn() },
  };
}

function serviceFor(tx: ReturnType<typeof transaction>) {
  const prisma = {
    $transaction: vi.fn((operation: (database: typeof tx) => unknown) => operation(tx)),
  };
  return new WalletService(prisma as never);
}

describe('WalletService', () => {
  it('reserves a credit once and records an append-only reservation entry', async () => {
    const tx = transaction();
    tx.generationWallet.upsert.mockResolvedValue({
      id: 'wallet-1',
      available: 2,
      reserved: 0,
      version: 1,
      creditType: CreditType.TEXT,
    });
    tx.generationWallet.update.mockResolvedValue({
      available: 1,
      reserved: 1,
      version: 2,
      creditType: CreditType.TEXT,
    });
    tx.generationReservation.create.mockResolvedValue({ id: 'reservation-1' });

    const result = await serviceFor(tx).reserve({
      userId: 'user-1',
      creditType: CreditType.TEXT,
      units: 1,
      operationKey: 'publication-1:text',
    });

    expect(result).toEqual({
      creditType: CreditType.TEXT,
      available: 1,
      reserved: 1,
      version: 2,
    });
    expect(tx.creditLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'RESERVE',
        operationKey: 'publication-1:text:reserve',
        reservationId: 'reservation-1',
      }),
    });
  });

  it('rejects a reservation when the available balance is exhausted', async () => {
    const tx = transaction();
    tx.generationWallet.upsert.mockResolvedValue({
      id: 'wallet-1',
      available: 0,
      reserved: 0,
      version: 1,
      creditType: CreditType.IMAGE,
    });

    await expect(
      serviceFor(tx).reserve({
        userId: 'user-1',
        creditType: CreditType.IMAGE,
        units: 1,
        operationKey: 'publication-1:image',
      }),
    ).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_IMAGE_CREDITS' } });
    expect(tx.generationReservation.create).not.toHaveBeenCalled();
  });

  it('does not settle an already committed reservation twice', async () => {
    const tx = transaction();
    tx.generationReservation.findUnique.mockResolvedValue({
      id: 'reservation-1',
      userId: 'user-1',
      creditType: CreditType.TEXT,
      units: 1,
      status: ReservationStatus.COMMITTED,
      wallet: {
        id: 'wallet-1',
        creditType: CreditType.TEXT,
        available: 1,
        reserved: 0,
        version: 3,
      },
    });

    const result = await serviceFor(tx).commit({
      userId: 'user-1',
      creditType: CreditType.TEXT,
      units: 1,
      operationKey: 'publication-1:text',
    });

    expect(result).toMatchObject({ available: 1, reserved: 0, version: 3 });
    expect(tx.generationWallet.update).not.toHaveBeenCalled();
    expect(tx.creditLedgerEntry.create).not.toHaveBeenCalled();
  });

  it('credits an onboarding gift idempotently through the append-only ledger', async () => {
    const tx = transaction();
    tx.generationWallet.upsert.mockResolvedValue({
      id: 'wallet-1',
      available: 0,
      reserved: 0,
      version: 1,
      creditType: CreditType.TEXT,
    });
    tx.generationWallet.update.mockResolvedValue({
      available: 5,
      reserved: 0,
      version: 2,
      creditType: CreditType.TEXT,
    });
    tx.creditLedgerEntry.findUnique.mockResolvedValue(null);

    const result = await serviceFor(tx).grant({
      userId: 'user-1',
      creditType: CreditType.TEXT,
      units: 5,
      operationKey: 'onboarding:user-1:text',
      kind: 'GIFT',
    });

    expect(result).toMatchObject({ available: 5, reserved: 0, version: 2 });
    expect(tx.creditLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'GIFT', units: 5 }),
    });
  });
});
