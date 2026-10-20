import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { YooKassaAdapter } from './yookassa.adapter.js';

function fixture() {
  return new YooKassaAdapter(
    new ConfigService({
      YOOKASSA_SHOP_ID: 'test-shop',
      YOOKASSA_SECRET_KEY: 'must-never-appear',
      YOOKASSA_RETURN_URL: 'https://example.test/return',
      YOOKASSA_API_BASE_URL: 'https://api.yookassa.ru/v3',
      YOOKASSA_REQUEST_TIMEOUT_MS: 100,
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('YooKassaAdapter', () => {
  it('uses backend price, capture and a durable attempt key without client pricing', async () => {
    const orderId = randomUUID();
    const attemptId = randomUUID();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: randomUUID(),
          status: 'pending',
          paid: false,
          test: true,
          amount: { value: '99.00', currency: 'RUB' },
          recipient: { account_id: 'test-shop' },
          metadata: { order_id: orderId, payment_attempt_id: attemptId },
          confirmation: { type: 'redirect', confirmation_url: 'https://yookassa.ru/checkout/test' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const payment = await fixture().createPayment({
      orderId,
      idempotencyKey: attemptId,
      amountMinor: 9900,
      currency: 'RUB',
      returnUrl: 'https://example.test/return',
    });
    expect(payment.status).toBe('pending');
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toMatchObject({
      amount: { value: '99.00', currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: 'https://example.test/return' },
      metadata: { order_id: orderId, payment_attempt_id: attemptId },
    });
    expect(call[1].headers).toMatchObject({ 'idempotence-key': attemptId });
    expect(call[1].redirect).toBe('error');
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['timeout', 'invalid-json', 'server-error'])('sanitizes %s errors', async (kind) => {
    const fetchMock = vi.fn();
    if (kind === 'timeout') fetchMock.mockRejectedValue(new Error('must-never-appear'));
    else
      fetchMock.mockResolvedValue(
        new Response('must-never-appear', { status: kind === 'server-error' ? 500 : 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await fixture().getPayment(randomUUID());
      expect.fail('provider error must be rejected');
    } catch (error) {
      expect(String(error)).not.toContain('must-never-appear');
      expect(error).toMatchObject({ response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' } });
    }
  });
});
