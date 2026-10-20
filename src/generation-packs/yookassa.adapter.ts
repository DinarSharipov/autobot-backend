import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../config/environment.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';

const paymentSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['pending', 'waiting_for_capture', 'succeeded', 'canceled']),
  paid: z.boolean(),
  test: z.boolean(),
  amount: z.object({ value: z.string().regex(/^\d+\.\d{2}$/), currency: z.string() }),
  recipient: z.object({ account_id: z.string() }),
  metadata: z.object({ order_id: z.string().uuid(), payment_attempt_id: z.string().uuid() }),
  confirmation: z
    .object({
      type: z.literal('redirect'),
      confirmation_url: z.url().refine((value) => new URL(value).protocol === 'https:'),
    })
    .optional(),
  expires_at: z.iso.datetime({ offset: true }).optional(),
});

const refundSchema = z.object({
  id: z.uuid(),
  payment_id: z.uuid(),
  status: z.enum(['pending', 'succeeded', 'canceled']),
  amount: z.object({ value: z.string().regex(/^\d+\.\d{2}$/), currency: z.string() }),
  created_at: z.iso.datetime({ offset: true }),
});
const refundListSchema = z.object({
  type: z.literal('list'),
  items: z.array(refundSchema).max(100),
  next_cursor: z.string().min(1).max(1024).optional(),
});
export type YooKassaRefund = z.infer<typeof refundSchema>;

export type YooKassaPayment = z.infer<typeof paymentSchema>;

export function minorAmount(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

@Injectable()
export class YooKassaAdapter {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  async createPayment(input: {
    amountMinor: number;
    currency: string;
    orderId: string;
    idempotencyKey: string;
    returnUrl: string;
  }): Promise<YooKassaPayment> {
    return this.request(
      '/payments',
      {
        method: 'POST',
        headers: { 'idempotence-key': input.idempotencyKey },
        body: JSON.stringify({
          amount: { value: minorAmount(input.amountMinor), currency: input.currency },
          capture: true,
          confirmation: { type: 'redirect', return_url: input.returnUrl },
          metadata: { order_id: input.orderId, payment_attempt_id: input.idempotencyKey },
        }),
      },
      paymentSchema,
    );
  }

  getPayment(paymentId: string): Promise<YooKassaPayment> {
    return this.request(
      `/payments/${encodeURIComponent(paymentId)}`,
      { method: 'GET' },
      paymentSchema,
    );
  }

  getRefund(refundId: string): Promise<YooKassaRefund> {
    return this.request(
      `/refunds/${encodeURIComponent(refundId)}`,
      { method: 'GET' },
      refundSchema,
    );
  }

  listRefunds(paymentId: string, cursor?: string) {
    const query = new URLSearchParams({ payment_id: paymentId, limit: '100' });
    if (cursor) query.set('cursor', cursor);
    return this.request(`/refunds?${query.toString()}`, { method: 'GET' }, refundListSchema);
  }

  private async request<T>(path: string, options: RequestInit, schema: z.ZodType<T>): Promise<T> {
    const shopId = this.config.get('YOOKASSA_SHOP_ID', { infer: true });
    const secretKey = this.config.get('YOOKASSA_SECRET_KEY', { infer: true });
    if (!shopId || !secretKey) throw this.error('PAYMENT_PROVIDER_NOT_CONFIGURED', 503);
    try {
      const response = await fetch(
        `${this.config.get('YOOKASSA_API_BASE_URL', { infer: true }).replace(/\/$/, '')}${path}`,
        {
          ...options,
          redirect: 'error',
          signal: AbortSignal.timeout(
            this.config.get('YOOKASSA_REQUEST_TIMEOUT_MS', { infer: true }),
          ),
          headers: {
            ...options.headers,
            authorization: `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`,
            'content-type': 'application/json',
          },
        },
      );
      if (!response.ok) throw this.error('PAYMENT_PROVIDER_UNAVAILABLE', 503);
      const payment = schema.safeParse(await response.json());
      if (!payment.success) throw this.error('PAYMENT_PROVIDER_INVALID_RESPONSE', 502);
      return payment.data;
    } catch (error) {
      if (error instanceof ApiHttpException) throw error;
      // Never expose fetch errors, provider bodies, headers or configuration.
      throw this.error('PAYMENT_PROVIDER_UNAVAILABLE', 503);
    }
  }

  private error(code: string, status: number): ApiHttpException {
    return new ApiHttpException(status, code, 'Payment provider request could not be completed.');
  }
}
