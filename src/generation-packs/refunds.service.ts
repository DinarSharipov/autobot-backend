import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { serializableTransaction } from '../common/database/serializable-transaction.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import type { PaymentRefund } from '../generated/prisma/client.js';
import { PaymentsService } from './payments.service.js';
import { PurchaseService } from './purchase.service.js';
import { WalletService } from './wallet.service.js';
import { YooKassaAdapter } from './yookassa.adapter.js';
import { cumulativeRefundUnits, parseRefundMinor } from './refund-policy.js';

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly provider: YooKassaAdapter,
    private readonly payments: PaymentsService,
    private readonly wallets: WalletService,
    private readonly purchases: PurchaseService,
  ) {}

  async list(userId: string, orderId: string) {
    await this.purchases.get(userId, orderId);
    const refunds = await this.prisma.paymentRefund.findMany({
      where: { purchaseOrderId: orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    return refunds.map((refund) => this.view(refund));
  }

  async check(userId: string, orderId: string) {
    await this.purchases.get(userId, orderId);
    await this.checkOrder(orderId);
    return this.purchases.get(userId, orderId);
  }

  async webhook(refundId: string) {
    if (!this.config.get('YOOKASSA_WEBHOOK_ENABLED', { infer: true })) {
      throw this.error('PAYMENT_WEBHOOK_DISABLED', 503);
    }
    const receipt = { event: 'refund.succeeded', refundId };
    const hash = this.digest(receipt);
    await this.prisma.paymentEvent.createMany({
      data: [
        {
          provider: 'yookassa',
          providerEventId: `received:${hash}`,
          status: 'RECEIVED',
          payloadHash: hash,
          payload: receipt,
        },
      ],
      skipDuplicates: true,
    });
    try {
      await this.verifyOne(refundId);
    } catch (error) {
      if (!(error instanceof ApiHttpException) || ![404, 409].includes(error.getStatus()))
        throw error;
      const payload = { receiptHash: hash, code: 'REFUND_VERIFICATION_FAILED' };
      await this.prisma.paymentEvent.createMany({
        data: [
          {
            provider: 'yookassa',
            providerEventId: `rejected:${hash}`,
            status: 'REJECTED',
            payloadHash: this.digest(payload),
            payload,
          },
        ],
        skipDuplicates: true,
      });
      this.logger.warn({ event: 'refund_notification_rejected' });
    }
    return { received: true };
  }

  async reconcile(limit = 100) {
    // Fair rotation over all paid test attempts also discovers missing webhooks.
    const orders = await this.prisma.purchaseOrder.findMany({
      where: {
        provider: 'yookassa',
        providerOrderId: { not: null },
        status: 'PAID',
        paymentIdempotencyKey: { not: null },
      },
      orderBy: [{ refundsCheckedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: limit,
    });
    let checked = 0;
    let failed = 0;
    for (const order of orders) {
      try {
        await this.checkOrder(order.id);
        checked++;
      } catch {
        failed++;
      } finally {
        // This is the attempt timestamp, including failures, so one failed order
        // cannot permanently starve the rest of a batch.
        await this.prisma.purchaseOrder.update({
          where: { id: order.id },
          data: { refundsCheckedAt: new Date() },
        });
      }
    }
    const result = { scanned: orders.length, checked, failed };
    this.logger.log({ event: 'refund_reconciliation_completed', ...result });
    return result;
  }

  private async checkOrder(orderId: string) {
    const order = await this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (!order.providerOrderId || order.provider !== 'yookassa')
      throw this.error('PAYMENT_NOT_CONFIRMED');
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const refunds = await this.provider.listRefunds(order.providerOrderId, cursor);
      for (const refund of refunds.items) {
        // Never let a provider list anomaly process another user's order.
        if (refund.payment_id !== order.providerOrderId)
          throw this.error('REFUND_VERIFICATION_FAILED');
        await this.verifyOne(refund.id, order.providerOrderId);
      }
      if (!refunds.next_cursor) return;
      if (cursors.has(refunds.next_cursor)) throw this.error('REFUND_RECONCILIATION_LIMIT');
      cursor = refunds.next_cursor;
      cursors.add(cursor);
    }
    throw this.error('REFUND_RECONCILIATION_LIMIT');
  }

  private async verifyOne(refundId: string, expectedPaymentId?: string) {
    const refund = await this.provider.getRefund(refundId);
    if (refund.id !== refundId || (expectedPaymentId && refund.payment_id !== expectedPaymentId)) {
      throw this.error('REFUND_VERIFICATION_FAILED');
    }
    const amountMinor = parseRefundMinor(refund.amount.value);
    // Refund objects have no shop/test fields. Verify those on their original
    // payment with our credentials, not on webhook-supplied data.
    const order = await this.payments.confirmForRefund(refund.payment_id);
    if (refund.amount.currency !== order.currency || amountMinor > order.priceMinor) {
      throw this.error('REFUND_VERIFICATION_FAILED');
    }
    await serializableTransaction(this.prisma, async (tx) => {
      const current = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } });
      const existing = await tx.paymentRefund.findUnique({ where: { providerRefundId: refundId } });
      if (
        existing &&
        (existing.purchaseOrderId !== current.id ||
          existing.amountMinor !== amountMinor ||
          existing.currency !== refund.amount.currency)
      ) {
        throw this.error('REFUND_VERIFICATION_FAILED');
      }
      const payload = {
        event: 'refund.verified',
        refundId,
        paymentId: refund.payment_id,
        status: refund.status,
        amountMinor,
        currency: refund.amount.currency,
        orderId: current.id,
      };
      const hash = this.digest(payload);
      await tx.paymentEvent.createMany({
        data: [
          {
            provider: 'yookassa',
            providerEventId: `verified-refund:${hash}`,
            status: 'VERIFIED',
            payloadHash: hash,
            payload,
            userId: current.userId,
            purchaseOrderId: current.id,
            processedAt: new Date(),
          },
        ],
        skipDuplicates: true,
      });
      // A verified stale response must not undo either final state.
      if (existing?.status === 'SUCCEEDED') return;
      if (existing?.status === 'CANCELLED') {
        if (refund.status === 'succeeded') throw this.error('REFUND_VERIFICATION_FAILED');
        return;
      }
      let delta = 0;
      if (refund.status === 'succeeded') {
        const totalMinor = current.refundedMinor + amountMinor;
        const totalUnits = cumulativeRefundUnits(totalMinor, current.priceMinor, current.units);
        delta = totalUnits - current.refundedUnits;
        if (delta < 0) throw this.error('REFUND_VERIFICATION_FAILED');
        if (delta > 0)
          await this.wallets.compensateRefund(
            {
              userId: current.userId,
              creditType: current.creditType,
              units: delta,
              purchaseOrderId: current.id,
              providerRefundId: refundId,
            },
            tx,
          );
        await tx.purchaseOrder.update({
          where: { id: current.id },
          data: { refundedMinor: totalMinor, refundedUnits: totalUnits },
        });
      }
      const status =
        refund.status === 'succeeded'
          ? 'SUCCEEDED'
          : refund.status === 'canceled'
            ? 'CANCELLED'
            : 'PENDING';
      const data = {
        status,
        compensatedUnits: delta,
        compensatedAt: status === 'SUCCEEDED' ? new Date() : null,
      } as const;
      await tx.paymentRefund.upsert({
        where: { providerRefundId: refundId },
        create: {
          providerRefundId: refundId,
          purchaseOrderId: current.id,
          amountMinor,
          currency: refund.amount.currency,
          ...data,
        },
        update: data,
      });
    });
    this.logger.log({ event: 'refund_verified', status: refund.status });
  }

  private view(refund: PaymentRefund) {
    return {
      id: refund.id,
      providerRefundId: refund.providerRefundId,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      status: refund.status,
      compensatedUnits: refund.compensatedUnits,
      compensatedAt: refund.compensatedAt?.toISOString() ?? null,
      createdAt: refund.createdAt.toISOString(),
    };
  }
  private digest(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  private error(code: string, status = 409) {
    return new ApiHttpException(status, code, 'Refund operation could not be completed.');
  }
}
