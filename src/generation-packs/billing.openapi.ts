import type { SchemaObject } from '@nestjs/swagger';

export const packSchema: SchemaObject = {
  type: 'object',
  required: ['code', 'creditType', 'units', 'priceMinor', 'currency', 'version'],
  properties: {
    code: { type: 'string', example: 'text-20' },
    creditType: { type: 'string', enum: ['TEXT', 'IMAGE'] },
    units: { type: 'integer', example: 20 },
    priceMinor: { type: 'integer', example: 9900 },
    currency: { type: 'string', example: 'RUB' },
    version: { type: 'integer', example: 1 },
  },
};
export const walletSchema: SchemaObject = {
  type: 'object',
  required: ['creditType', 'available', 'reserved', 'debt', 'version'],
  properties: {
    creditType: { type: 'string', enum: ['TEXT', 'IMAGE'] },
    available: { type: 'integer', example: 3 },
    reserved: { type: 'integer', example: 0 },
    debt: {
      type: 'integer',
      minimum: 0,
      example: 0,
      description:
        'Credits revoked after a refund that could not be recovered from available balance. New credit reservations are blocked until incoming credits repay this debt.',
    },
    version: { type: 'integer', example: 1 },
  },
};
export const ledgerSchema: SchemaObject = {
  type: 'object',
  required: ['kind', 'units', 'operationKey', 'createdAt', 'wallet'],
  properties: {
    kind: {
      type: 'string',
      enum: ['GIFT', 'PURCHASE', 'RESERVE', 'COMMIT', 'RELEASE', 'REFUND', 'ADJUSTMENT'],
    },
    units: {
      type: 'integer',
      description:
        'Positive operation magnitude. REFUND entries revoke credits (debit), including debt when credits were already spent or reserved.',
    },
    operationKey: { type: 'string' },
    publicationId: { type: 'string', nullable: true, format: 'uuid' },
    purchaseOrderId: { type: 'string', nullable: true, format: 'uuid' },
    createdAt: { type: 'string', format: 'date-time' },
    wallet: {
      type: 'object',
      required: ['creditType'],
      properties: { creditType: { type: 'string', enum: ['TEXT', 'IMAGE'] } },
    },
  },
};
export const purchaseOrderSchema: SchemaObject = {
  type: 'object',
  required: [
    'id',
    'packCode',
    'creditType',
    'units',
    'priceMinor',
    'currency',
    'packVersion',
    'status',
    'paymentStatus',
    'refundStatus',
    'refundedMinor',
    'refundedUnits',
    'fulfillmentStatus',
    'fulfilledAt',
    'providerPaymentId',
    'confirmationUrl',
    'paymentUrl',
    'expiresAt',
    'paidAt',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    packCode: { type: 'string', example: 'text-20' },
    creditType: { type: 'string', enum: ['TEXT', 'IMAGE'] },
    units: { type: 'integer', example: 20 },
    priceMinor: { type: 'integer', example: 9900 },
    currency: { type: 'string', example: 'RUB' },
    packVersion: { type: 'integer', example: 1 },
    status: {
      type: 'string',
      enum: ['PENDING', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED', 'FAILED'],
    },
    paymentStatus: {
      type: 'string',
      enum: ['NOT_CREATED', 'PENDING', 'SUCCEEDED', 'CANCELLED', 'EXPIRED', 'FAILED'],
    },
    refundStatus: { type: 'string', enum: ['NONE', 'PARTIAL', 'FULL'] },
    refundedMinor: { type: 'integer', minimum: 0 },
    refundedUnits: { type: 'integer', minimum: 0 },
    fulfillmentStatus: { type: 'string', enum: ['PENDING', 'FULFILLED'] },
    fulfilledAt: { type: 'string', nullable: true, format: 'date-time' },
    providerPaymentId: { type: 'string', nullable: true, format: 'uuid' },
    confirmationUrl: { type: 'string', nullable: true, format: 'uri' },
    paymentUrl: {
      type: 'string',
      nullable: true,
      format: 'uri',
      deprecated: true,
      description: 'Alias of confirmationUrl retained for compatibility.',
    },
    expiresAt: {
      type: 'string',
      nullable: true,
      format: 'date-time',
      description: 'Null if the provider did not supply an expiry; do not invent a deadline.',
    },
    paidAt: { type: 'string', nullable: true, format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};
export function billingResponse(schema: SchemaObject, list = false): SchemaObject {
  return {
    type: 'object',
    required: ['data'],
    properties: { data: list ? { type: 'array', items: schema } : schema },
  };
}
export const purchaseOrderResponse = billingResponse(purchaseOrderSchema);

export const refundSchema: SchemaObject = {
  type: 'object',
  required: [
    'id',
    'providerRefundId',
    'amountMinor',
    'currency',
    'status',
    'compensatedUnits',
    'compensatedAt',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    providerRefundId: { type: 'string', format: 'uuid' },
    amountMinor: { type: 'integer', minimum: 1 },
    currency: { type: 'string', example: 'RUB' },
    status: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'CANCELLED'] },
    compensatedUnits: {
      type: 'integer',
      minimum: 0,
      description:
        'Credits revoked by this refund. Cumulative rounding may produce zero for small partial refunds.',
    },
    compensatedAt: { type: 'string', nullable: true, format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};
