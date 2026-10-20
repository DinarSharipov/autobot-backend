import { describe, expect, it, vi } from 'vitest';
import { serializableTransaction } from './serializable-transaction.js';

describe('serializableTransaction', () => {
  it.each([{ code: 'P2034' }, { originalCode: '40001' }, { cause: { originalCode: '40P01' } }])(
    'retries a rolled back query or commit conflict: %j',
    async (error) => {
      const transaction = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('committed');
      const result = await serializableTransaction(
        { $transaction: transaction } as never,
        async () => Promise.resolve('unused'),
      );
      expect(result).toBe('committed');
      expect(transaction).toHaveBeenCalledTimes(2);
    },
  );
  it('does not retry unrelated provider/application errors', async () => {
    const error = new Error('failure');
    const transaction = vi.fn().mockRejectedValue(error);
    await expect(
      serializableTransaction({ $transaction: transaction } as never, async () =>
        Promise.resolve('unused'),
      ),
    ).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
