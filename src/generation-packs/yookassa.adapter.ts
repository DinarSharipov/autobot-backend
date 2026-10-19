import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../config/environment.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';

type YooKassaPayment = {
  id: string;
  status: string;
  confirmation?: { type?: string; confirmation_url?: string };
  expires_at?: string;
};

export type YooKassaPaymentView = {
  providerPaymentId: string;
  status: string;
  confirmationUrl: string | null;
  expiresAt: string | null;
};

@Injectable()
export class YooKassaAdapter {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  async createPayment(input: {
    amountMinor: number;
    currency: string;
    orderId: string;
    idempotencyKey: string;
  }): Promise<YooKassaPaymentView> {
    const shopId = this.config.get('YOOKASSA_SHOP_ID', { infer: true });
    const secretKey = this.config.get('YOOKASSA_SECRET_KEY', { infer: true });
    const returnUrl = this.config.get('YOOKASSA_RETURN_URL', { infer: true });
    if (!shopId || !secretKey || !returnUrl) {
      throw new ApiHttpException(
        503,
        'PAYMENT_PROVIDER_NOT_CONFIGURED',
        'Payment provider is not configured.',
      );
    }

    const response = await fetch(
      `${this.config.get('YOOKASSA_API_BASE_URL', { infer: true })}/payments`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`,
          'content-type': 'application/json',
          'idempotence-key': input.idempotencyKey,
        },
        body: JSON.stringify({
          amount: { value: (input.amountMinor / 100).toFixed(2), currency: input.currency },
          capture: true,
          description: `Autobot generation pack ${input.orderId}`,
          confirmation: { type: 'redirect', return_url: returnUrl },
          metadata: { order_id: input.orderId },
        }),
      },
    );
    if (!response.ok) {
      throw new ApiHttpException(502, 'PAYMENT_PROVIDER_ERROR', 'Payment provider request failed.');
    }
    const payment = (await response.json()) as YooKassaPayment;
    if (!payment.id || payment.confirmation?.type !== 'redirect') {
      throw new ApiHttpException(
        502,
        'PAYMENT_PROVIDER_INVALID_RESPONSE',
        'Payment provider returned an invalid response.',
      );
    }
    return {
      providerPaymentId: payment.id,
      status: payment.status,
      confirmationUrl: payment.confirmation.confirmation_url ?? null,
      expiresAt: payment.expires_at ?? null,
    };
  }
}
