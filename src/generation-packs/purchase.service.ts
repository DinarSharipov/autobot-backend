import { HttpStatus, Injectable } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency/idempotency.service.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';

export type PurchaseOrderView = {
  id: string;
  packCode: string;
  creditType: 'TEXT' | 'IMAGE';
  units: number;
  priceMinor: number;
  currency: string;
  packVersion: number;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  fulfilledAt: string | null;
  providerPaymentId: string | null;
  confirmationUrl: string | null;
  paymentUrl: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
};

@Injectable()
export class PurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async create(
    userId: string,
    packCode: string,
    idempotencyKey: string,
  ): Promise<PurchaseOrderView> {
    const normalizedCode = packCode.trim();
    if (!normalizedCode) {
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_GENERATION_PACK',
        'Generation pack code is required.',
      );
    }
    return this.idempotency.execute({
      userId,
      operation: 'purchase-order:create',
      key: idempotencyKey,
      requestHash: this.idempotency.digest({ packCode: normalizedCode }),
      handler: async (transaction) => {
        const pack = await transaction.generationPack.findUnique({
          where: { code: normalizedCode },
        });
        if (!pack || !pack.isActive) {
          throw new ApiHttpException(
            HttpStatus.NOT_FOUND,
            'GENERATION_PACK_NOT_FOUND',
            'The requested generation pack is unavailable.',
          );
        }
        const order = await transaction.purchaseOrder.create({
          data: {
            userId,
            packId: pack.id,
            idempotencyKey,
            creditType: pack.creditType,
            units: pack.units,
            priceMinor: pack.priceMinor,
            currency: pack.currency,
            packVersion: pack.version,
          },
          include: { pack: { select: { code: true } } },
        });
        return this.view(order);
      },
    });
  }

  async get(userId: string, orderId: string): Promise<PurchaseOrderView> {
    const order = await this.prisma.purchaseOrder.findFirst({
      where: { id: orderId, userId },
      include: { pack: { select: { code: true } } },
    });
    if (!order) {
      throw new ApiHttpException(
        HttpStatus.NOT_FOUND,
        'PURCHASE_ORDER_NOT_FOUND',
        'Order not found.',
      );
    }
    return this.view(order);
  }

  async list(userId: string): Promise<PurchaseOrderView[]> {
    const orders = await this.prisma.purchaseOrder.findMany({
      where: { userId },
      include: { pack: { select: { code: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    return orders.map((order) => this.view(order));
  }

  private view(order: {
    id: string;
    status: string;
    creditType: 'TEXT' | 'IMAGE';
    units: number;
    priceMinor: number;
    currency: string;
    packVersion: number;
    fulfillmentStatus?: string;
    fulfilledAt?: Date | null;
    providerOrderId?: string | null;
    paymentUrl: string | null;
    expiresAt: Date | null;
    paidAt: Date | null;
    createdAt: Date;
    pack: { code: string };
  }): PurchaseOrderView {
    return {
      id: order.id,
      packCode: order.pack.code,
      creditType: order.creditType,
      units: order.units,
      priceMinor: order.priceMinor,
      currency: order.currency,
      packVersion: order.packVersion,
      status: order.status,
      paymentStatus:
        order.status === 'AWAITING_PAYMENT'
          ? 'PENDING'
          : order.status === 'PENDING'
            ? 'NOT_CREATED'
            : order.status === 'PAID'
              ? 'SUCCEEDED'
              : order.status,
      fulfillmentStatus: order.fulfillmentStatus ?? 'PENDING',
      fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
      providerPaymentId: order.providerOrderId ?? null,
      confirmationUrl: order.paymentUrl,
      paymentUrl: order.paymentUrl,
      expiresAt: order.expiresAt?.toISOString() ?? null,
      paidAt: order.paidAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
    };
  }
}
