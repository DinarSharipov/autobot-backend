import { readFile, writeFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';
import {
  billingResponse,
  packSchema,
  walletSchema,
  ledgerSchema,
  purchaseOrderSchema,
  refundSchema,
} from '../src/generation-packs/billing.openapi.js';

const response = (schema) => ({
  description: 'Successful response',
  content: { 'application/json': { schema } },
});
const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'details', 'requestId'],
      properties: {
        code: {
          type: 'string',
          description: 'Machine-readable error code; see docs/BILLING_TEST_CHECKOUT.md.',
        },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
        requestId: { type: 'string' },
      },
    },
  },
};
const errors = Object.fromEntries(
  ['400', '401', '403', '404', '409', '422', '502', '503'].map((status) => [
    status,
    {
      ...response(errorSchema),
      description: 'Request rejected or provider unavailable; inspect error.code.',
    },
  ]),
);
const orderId = {
  name: 'orderId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const creditType = {
  name: 'creditType',
  in: 'query',
  schema: { type: 'string', enum: ['TEXT', 'IMAGE'] },
};
function operation(operationId, summary, schema, parameters = [], status = '200') {
  return {
    operationId,
    summary,
    tags: ['Billing'],
    parameters,
    responses: { [status]: response(schema), ...errors },
  };
}
const paths = {
  '/generation-packs': {
    get: operation(
      'listGenerationPacks',
      'List server-controlled pack prices in minor units',
      billingResponse(packSchema, true),
      [creditType],
    ),
  },
  '/wallets': {
    get: operation(
      'getWallets',
      'Get balances and ensure the idempotent onboarding gift',
      billingResponse(walletSchema, true),
    ),
  },
  '/wallets/ledger': {
    get: operation(
      'listWalletLedger',
      'List latest owned ledger entries',
      billingResponse(ledgerSchema, true),
      [
        creditType,
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      ],
    ),
  },
  '/purchase-orders': {
    get: operation(
      'listPurchaseOrders',
      'List latest 100 owned orders',
      billingResponse(purchaseOrderSchema, true),
    ),
    post: {
      ...operation(
        'createPurchaseOrder',
        'Create an idempotent order with immutable server price snapshot',
        billingResponse(purchaseOrderSchema),
        [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 16, maxLength: 128 },
          },
        ],
        '201',
      ),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['packCode'],
              additionalProperties: false,
              properties: {
                packCode: { type: 'string', minLength: 1, maxLength: 128, example: 'text-20' },
              },
            },
          },
        },
      },
    },
  },
  '/purchase-orders/{orderId}': {
    get: operation(
      'getPurchaseOrder',
      'Get an owned order; redirect never confirms payment',
      billingResponse(purchaseOrderSchema),
      [orderId],
    ),
  },
  '/purchase-orders/{orderId}/payment': {
    post: operation(
      'createOrderPayment',
      'Create or recover test payment; replay is keyed by the order',
      billingResponse(purchaseOrderSchema),
      [orderId],
    ),
  },
  '/purchase-orders/{orderId}/payment/check': {
    post: operation(
      'checkOrderPayment',
      'Check provider and fulfill a succeeded test payment',
      billingResponse(purchaseOrderSchema),
      [orderId],
    ),
  },
  '/purchase-orders/{orderId}/refunds': {
    get: operation(
      'listOrderRefunds',
      'List latest 100 verified refund states for an owned order',
      billingResponse(refundSchema, true),
      [orderId],
    ),
  },
  '/purchase-orders/{orderId}/refunds/check': {
    post: operation(
      'checkOrderRefunds',
      'Discover and verify existing provider refunds without initiating a transfer',
      billingResponse(purchaseOrderSchema),
      [orderId],
    ),
  },
  '/payments/yookassa/webhook': {
    post: {
      ...operation('yookassaWebhook', 'Untrusted notification; server verification is mandatory', {
        type: 'object',
        required: ['received'],
        properties: { received: { type: 'boolean', example: true } },
      }),
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['type', 'event', 'object'],
              properties: {
                type: { type: 'string', enum: ['notification'] },
                event: {
                  type: 'string',
                  enum: [
                    'payment.succeeded',
                    'payment.canceled',
                    'payment.waiting_for_capture',
                    'refund.succeeded',
                  ],
                },
                object: {
                  type: 'object',
                  required: ['id'],
                  additionalProperties: true,
                  properties: { id: { type: 'string', format: 'uuid' } },
                },
              },
            },
          },
        },
      },
    },
  },
};
const document = {
  openapi: '3.1.0',
  info: {
    title: 'Autobot billing contract',
    version: '1.1.0',
    description:
      'Additive v1 bot contract. Test-only checkout is disabled by default. Browser mutations require CSRF; bot requests require HMAC companion headers from ADR 0003.',
  },
  servers: [{ url: 'http://autobot-api:3000/api/v1', description: 'Internal bot boundary' }],
  tags: [{ name: 'Billing', description: 'Owned prepaid wallets and test checkout' }],
  security: [{ cookieSession: [] }, { botSignature: [] }],
  paths,
  components: {
    securitySchemes: {
      cookieSession: { type: 'apiKey', in: 'cookie', name: '__Host-autobot_session' },
      botSignature: { type: 'apiKey', in: 'header', name: 'X-Autobot-Signature' },
    },
  },
};
function jsonSchema(value) {
  if (Array.isArray(value)) return value.map(jsonSchema);
  if (value && typeof value === 'object') {
    const converted = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'nullable')
        .map(([key, item]) => [key, jsonSchema(item)]),
    );
    if (value.nullable) converted.type = [value.type, 'null'];
    return converted;
  }
  return value;
}
const target = new URL('../docs/openapi/billing.openapi.json', import.meta.url);
const contents = await format(JSON.stringify(jsonSchema(document)), {
  ...(await resolveConfig(target.pathname)),
  parser: 'json',
});
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')) !== contents)
    throw new Error('Billing contract is stale; run npm run openapi:billing:generate');
} else await writeFile(target, contents);
