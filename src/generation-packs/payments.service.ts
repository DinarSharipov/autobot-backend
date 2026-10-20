import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { serializableTransaction } from '../common/database/serializable-transaction.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import type { AppEnvironment } from '../config/environment.js';
import type { PurchaseOrder } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { PurchaseService } from './purchase.service.js';
import { WalletService } from './wallet.service.js';
import { minorAmount, YooKassaAdapter, type YooKassaPayment } from './yookassa.adapter.js';

const SAFE_REPLAY_MS = 23 * 60 * 60 * 1000;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly provider: YooKassaAdapter,
    private readonly wallets: WalletService,
    private readonly purchases: PurchaseService,
  ) {}

  async create(userId: string, orderId: string) {
    // Ownership is checked even when checkout is disabled.
    await this.owned(userId, orderId);
    if (!this.config.get('YOOKASSA_TEST_CHECKOUT_ENABLED', { infer: true })) {
      throw this.error('CHECKOUT_DISABLED', 503);
    }
    if (!this.config.get('YOOKASSA_TEST_USER_IDS', { infer: true }).includes(userId)) {
      throw this.error('CHECKOUT_NOT_ALLOWED', 403);
    }
    const returnUrl = this.config.get('YOOKASSA_RETURN_URL', { infer: true });
    if (!returnUrl) throw this.error('PAYMENT_PROVIDER_NOT_CONFIGURED', 503);
    const order = await serializableTransaction(this.prisma, async (tx) => {
      const current = await tx.purchaseOrder.findFirstOrThrow({ where: { id: orderId, userId } });
      if (current.providerOrderId) return current;
      if (!['PENDING', 'AWAITING_PAYMENT'].includes(current.status)) {
        throw this.error('PAYMENT_NOT_CONFIRMED');
      }
      if (current.paymentIdempotencyKey) return current;
      // Commit the key BEFORE contacting YooKassa. Lost HTTP responses reuse it.
      return tx.purchaseOrder.update({
        where: { id: current.id },
        data: {
          provider: 'yookassa',
          paymentIdempotencyKey: randomUUID(),
          paymentStartedAt: new Date(),
          paymentReturnUrl: returnUrl,
          status: 'AWAITING_PAYMENT',
        },
      });
    });
    if (!order.providerOrderId) await this.submit(order);
    return this.purchases.get(userId, orderId);
  }

  async check(userId: string, orderId: string) {
    const order = await this.owned(userId, orderId);
    if (!order.paymentIdempotencyKey) throw this.error('PAYMENT_NOT_CONFIRMED');
    await this.refresh(order);
    return this.purchases.get(userId, orderId);
  }

  async webhook(event: string, paymentId: string) {
    if (!this.config.get('YOOKASSA_WEBHOOK_ENABLED', { infer: true })) {
      throw this.error('PAYMENT_WEBHOOK_DISABLED', 503);
    }
    const receipt = { event, paymentId };
    const receiptHash = this.digest(receipt);
    await this.prisma.paymentEvent.createMany({
      data: [
        {
          provider: 'yookassa',
          providerEventId: `received:${receiptHash}`,
          status: 'RECEIVED',
          payloadHash: receiptHash,
          payload: receipt,
        },
      ],
      skipDuplicates: true,
    });
    // Webhook payloads are untrusted hints. Always GET the object using our credentials.
    const payment = await this.provider.getPayment(paymentId);
    if (payment.id !== paymentId) throw this.error('PAYMENT_VERIFICATION_FAILED');
    const order = await this.prisma.purchaseOrder.findFirst({
      where: {
        OR: [
          { providerOrderId: paymentId },
          {
            id: payment.metadata.order_id,
            paymentIdempotencyKey: payment.metadata.payment_attempt_id,
          },
        ],
      },
    });
    if (!order) {
      await this.reject(receiptHash, 'PAYMENT_ORDER_NOT_FOUND');
      return { received: true };
    }
    try {
      await this.apply(order, payment);
    } catch (error) {
      if (error instanceof ApiHttpException && error.getStatus() === 409) {
        await this.reject(receiptHash, 'PAYMENT_VERIFICATION_FAILED');
        return { received: true };
      }
      throw error;
    }
    return { received: true };
  }

  async reconcile(limit = 100) {
    const orders = await this.prisma.purchaseOrder.findMany({
      where: {
        provider: 'yookassa',
        paymentIdempotencyKey: { not: null },
        OR: [
          { status: { in: ['PENDING', 'AWAITING_PAYMENT'] } },
          { status: 'PAID', fulfillmentStatus: 'PENDING' },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    let checked = 0;
    let failed = 0;
    for (const order of orders) {
      try {
        await this.refresh(order);
        checked++;
      } catch {
        failed++;
      }
    }
    const result = { scanned: orders.length, checked, failed };
    this.logger.log({ event: 'payment_reconciliation_completed', ...result });
    return result;
  }

  private async refresh(order: PurchaseOrder) {
    if (!order.providerOrderId) return this.submit(order);
    const payment = await this.provider.getPayment(order.providerOrderId);
    return this.apply(order, payment);
  }

  private async submit(order: PurchaseOrder) {
    if (
      !order.paymentIdempotencyKey ||
      !order.paymentReturnUrl ||
      !order.paymentStartedAt ||
      Date.now() - order.paymentStartedAt.getTime() >= SAFE_REPLAY_MS
    ) {
      // YooKassa forgets idempotency keys after 24h. Never risk a second charge.
      throw this.error('PAYMENT_RECONCILIATION_REQUIRED');
    }
    const payment = await this.provider.createPayment({
      amountMinor: order.priceMinor,
      currency: order.currency,
      orderId: order.id,
      idempotencyKey: order.paymentIdempotencyKey,
      returnUrl: order.paymentReturnUrl,
    });
    return this.apply(order, payment);
  }

  private async apply(order: PurchaseOrder, payment: YooKassaPayment) {
    this.verify(order, payment);
    await serializableTransaction(this.prisma, async (tx) => {
      const current = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } });
      this.verify(current, payment);
      const now = new Date();
      const safePayload = {
        paymentId: payment.id,
        status: payment.status,
        test: payment.test,
        amount: payment.amount,
        accountId: payment.recipient.account_id,
        orderId: current.id,
      };
      const hash = this.digest(safePayload);
      await tx.paymentEvent.createMany({
        data: [
          {
            provider: 'yookassa',
            providerEventId: `verified:${hash}`,
            userId: current.userId,
            purchaseOrderId: current.id,
            status: 'VERIFIED',
            payloadHash: hash,
            payload: safePayload,
            processedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      if (current.status === 'PAID' && payment.status !== 'succeeded') return;
      if (current.status === 'CANCELLED' && payment.status !== 'succeeded') return;
      const succeeded = payment.status === 'succeeded';
      if (succeeded) {
        await this.wallets.grant(
          {
            userId: current.userId,
            creditType: current.creditType,
            units: current.units,
            kind: 'PURCHASE',
            operationKey: `purchase:${current.id}`,
            purchaseOrderId: current.id,
          },
          tx,
        );
      }
      await tx.purchaseOrder.update({
        where: { id: current.id },
        data: {
          providerOrderId: payment.id,
          status: succeeded
            ? 'PAID'
            : payment.status === 'canceled'
              ? 'CANCELLED'
              : 'AWAITING_PAYMENT',
          ...(payment.confirmation ? { paymentUrl: payment.confirmation.confirmation_url } : {}),
          ...(payment.expires_at ? { expiresAt: new Date(payment.expires_at) } : {}),
          ...(succeeded
            ? {
                paidAt: current.paidAt ?? now,
                fulfillmentStatus: 'FULFILLED',
                fulfilledAt: current.fulfilledAt ?? now,
              }
            : {}),
        },
      });
    });
    this.logger.log({ event: 'payment_verified', status: payment.status });
  }

  private verify(order: PurchaseOrder, payment: YooKassaPayment) {
    if (
      order.provider !== 'yookassa' ||
      !order.paymentIdempotencyKey ||
      (order.providerOrderId !== null && order.providerOrderId !== payment.id) ||
      payment.metadata.order_id !== order.id ||
      payment.metadata.payment_attempt_id !== order.paymentIdempotencyKey ||
      payment.recipient.account_id !== this.config.get('YOOKASSA_SHOP_ID', { infer: true }) ||
      payment.amount.value !== minorAmount(order.priceMinor) ||
      payment.amount.currency !== order.currency ||
      payment.test !== true ||
      (payment.status === 'succeeded' && payment.paid !== true)
    ) {
      throw this.error('PAYMENT_VERIFICATION_FAILED');
    }
  }

  private async owned(userId: string, orderId: string) {
    const order = await this.prisma.purchaseOrder.findFirst({ where: { id: orderId, userId } });
    if (!order) throw this.error('PURCHASE_ORDER_NOT_FOUND', 404);
    return order;
  }

  private async reject(receiptHash: string, code: string) {
    const payload = { receiptHash, code };
    await this.prisma.paymentEvent.createMany({
      data: [
        {
          provider: 'yookassa',
          providerEventId: `rejected:${receiptHash}`,
          status: 'REJECTED',
          payloadHash: this.digest(payload),
          payload,
        },
      ],
      skipDuplicates: true,
    });
    this.logger.warn({ event: 'payment_notification_rejected', code });
  }

  private digest(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  private error(code: string, status = 409) {
    return new ApiHttpException(status, code, 'Payment operation could not be completed.');
  }
}
