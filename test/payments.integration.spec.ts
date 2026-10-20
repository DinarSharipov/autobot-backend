import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApplication } from '../src/bootstrap.js';
import { canonicalBotRequest } from '../src/auth/bot-request-signature.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { IdentityService } from '../src/users/identity.service.js';
import { PurchaseService } from '../src/generation-packs/purchase.service.js';
import { RefundsService } from '../src/generation-packs/refunds.service.js';
import { PaymentsService } from '../src/generation-packs/payments.service.js';
import { WalletService } from '../src/generation-packs/wallet.service.js';
import type { YooKassaPayment, YooKassaRefund } from '../src/generation-packs/yookassa.adapter.js';
import { withoutBackgroundJobs } from './support/without-background-jobs.js';
import { cleanTestDatabase } from './support/test-database.js';

describe('test checkout through REST, provider HTTP and PostgreSQL', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let refunds: RefundsService;
  let wallets: WalletService;
  let purchases: PurchaseService;
  let config: ConfigService;
  let userId: string;
  let ownerTelegramId: string;
  let lostResponse = false;
  const providerPayments = new Map<string, YooKassaPayment>();
  const providerRefunds = new Map<string, YooKassaRefund>();
  let failRefundReads = false;
  let refundPageSize = 100;
  const attempts = new Map<string, string>();
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith('https://api.yookassa.ru/v3/refunds')) {
      if (init?.method !== 'GET')
        throw new Error('Refund money transfers are forbidden in this slice');
      if (failRefundReads) return Promise.resolve(new Response('{}', { status: 503 }));
      const parsed = new URL(url);
      if (parsed.pathname === '/v3/refunds') {
        const items = [...providerRefunds.values()]
          .filter((refund) => refund.payment_id === parsed.searchParams.get('payment_id'))
          .reverse();
        const offset = Number(parsed.searchParams.get('cursor') ?? 0);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'list',
              items: items.slice(offset, offset + refundPageSize),
              ...(offset + refundPageSize < items.length
                ? { next_cursor: String(offset + refundPageSize) }
                : {}),
            }),
          ),
        );
      }
      const refund = providerRefunds.get(parsed.pathname.split('/').at(-1) ?? '');
      return Promise.resolve(
        new Response(JSON.stringify(refund ?? {}), { status: refund ? 200 : 404 }),
      );
    }
    if (!url.startsWith('https://api.yookassa.ru/v3/payments'))
      throw new Error('Unexpected provider request');
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as {
        amount: { value: string; currency: string };
        metadata: { order_id: string; payment_attempt_id: string };
      };
      const key = (init.headers as Record<string, string>)['idempotence-key'];
      if (!key) throw new Error('Missing provider idempotency');
      let id = attempts.get(key);
      if (!id) {
        id = randomUUID();
        attempts.set(key, id);
        providerPayments.set(id, {
          id,
          status: 'pending',
          paid: false,
          test: true,
          amount: body.amount,
          recipient: { account_id: 'test-shop' },
          metadata: body.metadata,
          confirmation: {
            type: 'redirect',
            confirmation_url: `https://yookassa.ru/checkout/${id}`,
          },
        });
      }
      if (lostResponse) {
        lostResponse = false;
        throw new Error('Provider timeout after creating payment');
      }
      return Promise.resolve(new Response(JSON.stringify(providerPayments.get(id))));
    }
    const payment = providerPayments.get(url.split('/').at(-1) ?? '');
    return Promise.resolve(
      new Response(JSON.stringify(payment ?? {}), { status: payment ? 200 : 404 }),
    );
  });

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    const module = await withoutBackgroundJobs(
      Test.createTestingModule({ imports: [AppModule] }),
    ).compile();
    app = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    config = app.get(ConfigService);
    config.set('YOOKASSA_SHOP_ID', 'test-shop');
    config.set('YOOKASSA_SECRET_KEY', 'test-only-secret');
    config.set('YOOKASSA_RETURN_URL', 'https://example.test/return');
    configureApplication(app);
    await app.init();
    prisma = app.get(PrismaService);
    payments = app.get(PaymentsService);
    refunds = app.get(RefundsService);
    purchases = app.get(PurchaseService);
    wallets = app.get(WalletService);
  });
  beforeEach(async () => {
    await cleanTestDatabase(prisma, process.env.DATABASE_URL ?? '');
    providerPayments.clear();
    providerRefunds.clear();
    failRefundReads = false;
    refundPageSize = 100;
    attempts.clear();
    fetchMock.mockClear();
    lostResponse = false;
    config.set('YOOKASSA_TEST_CHECKOUT_ENABLED', true);
    config.set('YOOKASSA_RETURN_URL', 'https://example.test/return');
    config.set('YOOKASSA_WEBHOOK_ENABLED', true);
    ownerTelegramId = String(990000 + Math.floor(Math.random() * 9999));
    const user = await app.get(IdentityService).resolveBotUser({ telegramUserId: ownerTelegramId });
    userId = user.id;
    config.set('YOOKASSA_TEST_USER_IDS', [userId]);
    await prisma.generationPack.upsert({
      where: { code: 'text-20' },
      create: { code: 'text-20', creditType: 'TEXT', units: 20, priceMinor: 9900, currency: 'RUB' },
      update: { isActive: true, priceMinor: 9900, version: 1 },
    });
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  function signed(
    method: 'POST' | 'GET',
    path: string,
    body?: unknown,
    telegramId = ownerTelegramId,
  ) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const canonical = canonicalBotRequest({
      method,
      originalUrl: path,
      body: Buffer.from(raw),
      timestamp,
      nonce,
      telegramUserId: telegramId,
    });
    const call = request(app.getHttpServer())
      [method === 'GET' ? 'get' : 'post'](path)
      .set({
        'X-Autobot-Service': 'autobot-bot',
        'X-Autobot-Key-Id': 'test-key',
        'X-Autobot-Timestamp': timestamp,
        'X-Autobot-Nonce': nonce,
        'X-Autobot-Signature': `v1=${createHmac('sha256', 'test-secret-32-bytes-long-1234567890').update(canonical).digest('hex')}`,
        'X-Telegram-User-Id': telegramId,
        'Idempotency-Key': randomUUID(),
      });
    return body === undefined ? call : call.set('Content-Type', 'application/json').send(raw);
  }
  async function order() {
    return purchases.create(userId, 'text-20', randomUUID());
  }
  async function start() {
    const initial = await order();
    await payments.create(userId, initial.id);
    const row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: initial.id } });
    const payment = providerPayments.get(row.providerOrderId ?? '');
    if (!payment) throw new Error('Payment fixture missing');
    return { orderId: row.id, payment };
  }
  function webhook(id: string, event = 'payment.succeeded') {
    return request(app.getHttpServer())
      .post('/api/v1/payments/yookassa/webhook')
      .send({
        type: 'notification',
        event,
        object: { id, status: 'succeeded', paid: true, sensitive: 'must-not-persist' },
      });
  }

  it('publishes concrete OpenAPI schemas for billing and payment routes', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    const document = response.body as { paths: Record<string, unknown> };
    for (const path of [
      'generation-packs',
      'wallets',
      'wallets/ledger',
      'purchase-orders',
      'purchase-orders/{orderId}',
      'purchase-orders/{orderId}/payment',
      'purchase-orders/{orderId}/payment/check',
      'purchase-orders/{orderId}/refunds',
      'purchase-orders/{orderId}/refunds/check',
      'payments/yookassa/webhook',
    ]) {
      expect(document.paths[`/api/v1/${path}`]).toBeDefined();
    }
  });

  it('creates pending checkout and never grants credits from a redirect', async () => {
    const initial = await order();
    const response = await signed('POST', `/api/v1/purchase-orders/${initial.id}/payment`).expect(
      200,
    );
    expect(response.body).toMatchObject({
      data: { status: 'AWAITING_PAYMENT', paymentStatus: 'PENDING', fulfillmentStatus: 'PENDING' },
    });
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'PURCHASE' } })).toBe(0);
    await signed('GET', `/api/v1/purchase-orders/${initial.id}`).expect(200);
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'PURCHASE' } })).toBe(0);
  });

  it('fulfills concurrent duplicate webhooks and polls once in one transaction', async () => {
    const { orderId, payment } = await start();
    payment.status = 'succeeded';
    payment.paid = true;
    const responses = await Promise.all([
      webhook(payment.id),
      webhook(payment.id),
      signed('POST', `/api/v1/purchase-orders/${orderId}/payment/check`),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'PURCHASE' } })).toBe(1);
    expect(
      await prisma.generationWallet.findFirst({ where: { userId, creditType: 'TEXT' } }),
    ).toMatchObject({ available: 20 });
    const result = await purchases.get(userId, orderId);
    expect(result).toMatchObject({
      status: 'PAID',
      paymentStatus: 'SUCCEEDED',
      fulfillmentStatus: 'FULFILLED',
    });
    expect(result.fulfilledAt).not.toBeNull();
    const before = await prisma.paymentEvent.findMany({ orderBy: { id: 'asc' } });
    await webhook(payment.id).expect(200);
    expect(await prisma.paymentEvent.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(JSON.stringify(before)).not.toContain('must-not-persist');
  });

  it('does not trust forged success notifications for a pending payment', async () => {
    const { payment } = await start();
    await webhook(payment.id).expect(200);
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'PURCHASE' } })).toBe(0);
    await webhook(randomUUID()).expect(503);
  });

  it.each(['amount', 'currency', 'account', 'association', 'attempt', 'live', 'unpaid'])(
    'rejects provider %s mismatch without granting credits',
    async (mismatch) => {
      const { orderId, payment } = await start();
      payment.status = 'succeeded';
      payment.paid = true;
      if (mismatch === 'amount') payment.amount.value = '98.99';
      if (mismatch === 'currency') payment.amount.currency = 'USD';
      if (mismatch === 'account') payment.recipient.account_id = 'another-shop';
      if (mismatch === 'association') payment.metadata.order_id = randomUUID();
      if (mismatch === 'attempt') payment.metadata.payment_attempt_id = randomUUID();
      if (mismatch === 'live') payment.test = false;
      if (mismatch === 'unpaid') payment.paid = false;
      await signed('POST', `/api/v1/purchase-orders/${orderId}/payment/check`).expect(409);
      await webhook(payment.id).expect(200);
      expect(await prisma.creditLedgerEntry.count({ where: { kind: 'PURCHASE' } })).toBe(0);
      expect(await prisma.paymentEvent.count({ where: { status: 'REJECTED' } })).toBe(1);
    },
  );

  it('recovers a lost create response with the persisted provider key', async () => {
    const initial = await order();
    lostResponse = true;
    await signed('POST', `/api/v1/purchase-orders/${initial.id}/payment`).expect(503);
    const stored = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: initial.id } });
    expect(stored.paymentIdempotencyKey).toBeTruthy();
    expect(stored.providerOrderId).toBeNull();
    config.set('YOOKASSA_RETURN_URL', 'https://example.test/new-config');
    await Promise.all([payments.create(userId, initial.id), payments.create(userId, initial.id)]);
    const postCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
    const bodies = postCalls.map((call) => JSON.parse(call[1]?.body as string) as unknown);
    expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
    expect(attempts.size).toBe(1);
    expect(providerPayments.size).toBe(1);
    expect(
      (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: initial.id } }))
        .paymentIdempotencyKey,
    ).toBe(stored.paymentIdempotencyKey);
  });

  it('blocks unsafe replay after provider idempotency retention', async () => {
    const initial = await order();
    lostResponse = true;
    await expect(payments.create(userId, initial.id)).rejects.toMatchObject({
      response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' },
    });
    await prisma.purchaseOrder.update({
      where: { id: initial.id },
      data: { paymentStartedAt: new Date(Date.now() - 24 * 3600_000) },
    });
    fetchMock.mockClear();
    await expect(payments.create(userId, initial.id)).rejects.toMatchObject({
      response: { code: 'PAYMENT_RECONCILIATION_REQUIRED' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rolls back grant failure and recovers paid-but-unfulfilled orders', async () => {
    const { orderId, payment } = await start();
    payment.status = 'succeeded';
    payment.paid = true;
    const original = wallets.grant.bind(wallets);
    const failure = vi.spyOn(wallets, 'grant').mockImplementationOnce(async (input, database) => {
      await original(input, database);
      throw new Error('Crash after ledger insertion');
    });
    await expect(payments.check(userId, orderId)).rejects.toThrow('Crash');
    failure.mockRestore();
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'PURCHASE' } })).toBe(0);
    expect((await purchases.get(userId, orderId)).fulfillmentStatus).toBe('PENDING');
    await prisma.purchaseOrder.update({
      where: { id: orderId },
      data: { status: 'PAID', paidAt: new Date() },
    });
    expect(await payments.reconcile()).toEqual({ scanned: 1, checked: 1, failed: 0 });
    expect((await purchases.get(userId, orderId)).fulfillmentStatus).toBe('FULFILLED');
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'PURCHASE' } })).toBe(1);
    await payments.reconcile();
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'PURCHASE' } })).toBe(1);
  });

  it('never regresses a paid order on stale notifications', async () => {
    const { orderId, payment } = await start();
    payment.status = 'succeeded';
    payment.paid = true;
    await payments.check(userId, orderId);
    payment.status = 'pending';
    payment.paid = false;
    await webhook(payment.id, 'payment.canceled').expect(200);
    expect((await purchases.get(userId, orderId)).status).toBe('PAID');
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'PURCHASE' } })).toBe(1);
  });

  it('checks ownership and the disabled checkout gate before contacting the provider', async () => {
    const initial = await order();
    const otherId = '99887766';
    await app.get(IdentityService).resolveBotUser({ telegramUserId: otherId });
    for (const suffix of ['', '/payment', '/payment/check']) {
      await signed(
        suffix ? 'POST' : 'GET',
        `/api/v1/purchase-orders/${initial.id}${suffix}`,
        undefined,
        otherId,
      ).expect(404);
    }
    config.set('YOOKASSA_TEST_CHECKOUT_ENABLED', false);
    await signed('POST', `/api/v1/purchase-orders/${initial.id}/payment`).expect(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('onboards once and reserves the final credit atomically', async () => {
    await Promise.all(Array.from({ length: 8 }, () => wallets.balances(userId)));
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'GIFT' } })).toBe(2);
    const results = await Promise.allSettled(
      [1, 2, 3].map((n) =>
        wallets.reserve({ userId, creditType: 'IMAGE', units: 1, operationKey: `reserve:${n}` }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(2);
    expect(
      await prisma.generationWallet.findFirst({ where: { userId, creditType: 'IMAGE' } }),
    ).toMatchObject({ available: 0, reserved: 1 });
  });
  it('retains order snapshots through the additive migration rollback/reapply', async () => {
    const initial = await order();
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        DROP TRIGGER payment_event_append_only ON "PaymentEvent";
        DROP FUNCTION reject_payment_event_mutation();
        ALTER TABLE "PurchaseOrder" DROP COLUMN "paymentIdempotencyKey", DROP COLUMN "paymentStartedAt",
          DROP COLUMN "paymentReturnUrl", DROP COLUMN "fulfillmentStatus", DROP COLUMN "fulfilledAt";
        DROP TYPE "CreditFulfillmentStatus";
      `);
      const oldView = await client.query<{ units: number; priceMinor: number; status: string }>(
        'SELECT "units", "priceMinor", "status" FROM "PurchaseOrder" WHERE id = $1',
        [initial.id],
      );
      expect(oldView.rows).toEqual([{ units: 20, priceMinor: 9900, status: 'PENDING' }]);
      await client.query(
        await readFile(
          'prisma/migrations/20261020090000_test_payment_lifecycle/migration.sql',
          'utf8',
        ),
      );
      const newView = await client.query<{ fulfillmentStatus: string }>(
        'SELECT "fulfillmentStatus" FROM "PurchaseOrder" WHERE id = $1',
        [initial.id],
      );
      expect(newView.rows).toEqual([{ fulfillmentStatus: 'PENDING' }]);
    } finally {
      // Keep migration history and every pre-existing row untouched.
      await client.query('ROLLBACK');
      await client.end();
    }
    expect((await purchases.get(userId, initial.id)).priceMinor).toBe(9900);
  });

  it('enforces immutable payment events at database level', async () => {
    const { payment } = await start();
    await webhook(payment.id).expect(200);
    const event = await prisma.paymentEvent.findFirstOrThrow();
    await expect(
      prisma.paymentEvent.update({ where: { id: event.id }, data: { status: 'REJECTED' } }),
    ).rejects.toThrow();
    await expect(prisma.paymentEvent.delete({ where: { id: event.id } })).rejects.toThrow();
    expect(await prisma.paymentEvent.findUnique({ where: { id: event.id } })).toEqual(event);
  });

  it('creates orders through HMAC REST and retains immutable price snapshots', async () => {
    const path = '/api/v1/purchase-orders';
    const created = await signed('POST', path, { packCode: 'text-20' }).expect(201);
    const body = created.body as { data: { id: string } };
    await prisma.generationPack.update({
      where: { code: 'text-20' },
      data: { priceMinor: 10900, version: 2 },
    });
    const snapshot = await purchases.get(userId, body.data.id);
    expect(snapshot).toMatchObject({ units: 20, priceMinor: 9900, packVersion: 1 });
    await prisma.generationPack.update({
      where: { code: 'text-20' },
      data: { priceMinor: 9900, version: 1 },
    });
  });

  it('blocks users outside the explicit test allowlist and disables webhook independently', async () => {
    const initial = await order();
    config.set('YOOKASSA_TEST_USER_IDS', []);
    await signed('POST', `/api/v1/purchase-orders/${initial.id}/payment`).expect(403);
    config.set('YOOKASSA_WEBHOOK_ENABLED', false);
    await webhook(randomUUID()).expect(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.paymentEvent.count()).toBe(0);
  });
  it('accepts a verified webhook arriving before the create response was saved', async () => {
    const initial = await order();
    lostResponse = true;
    await expect(payments.create(userId, initial.id)).rejects.toMatchObject({
      response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' },
    });
    const payment = [...providerPayments.values()][0];
    if (!payment) throw new Error('Missing payment fixture');
    payment.status = 'succeeded';
    payment.paid = true;
    await webhook(payment.id).expect(200);
    const result = await payments.create(userId, initial.id);
    expect(result).toMatchObject({
      providerPaymentId: payment.id,
      status: 'PAID',
      fulfillmentStatus: 'FULFILLED',
    });
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'PURCHASE' } })).toBe(1);
  });

  it('reuses the same order for concurrent creates with the same client idempotency key', async () => {
    const key = randomUUID();
    const results = await Promise.all([
      purchases.create(userId, 'text-20', key),
      purchases.create(userId, 'text-20', key),
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(await prisma.purchaseOrder.count({ where: { userId } })).toBe(1);
  });
  async function paidOrder() {
    const result = await start();
    result.payment.status = 'succeeded';
    result.payment.paid = true;
    await payments.check(userId, result.orderId);
    return result;
  }
  function refund(
    paymentId: string,
    value = '99.00',
    status: YooKassaRefund['status'] = 'succeeded',
  ) {
    const result: YooKassaRefund = {
      id: randomUUID(),
      payment_id: paymentId,
      amount: { value, currency: 'RUB' },
      status,
      created_at: new Date().toISOString(),
    };
    providerRefunds.set(result.id, result);
    return result;
  }
  function refundWebhook(id: string) {
    return webhook(id, 'refund.succeeded');
  }

  it('revokes a full refund exactly once under duplicate webhook and polling races', async () => {
    const { orderId, payment } = await paidOrder();
    const result = refund(payment.id);
    fetchMock.mockClear();
    const responses = await Promise.all([
      refundWebhook(result.id),
      refundWebhook(result.id),
      signed('POST', `/api/v1/purchase-orders/${orderId}/refunds/check`),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'REFUND' } })).toBe(1);
    expect(await prisma.paymentRefund.count()).toBe(1);
    expect(await purchases.get(userId, orderId)).toMatchObject({
      status: 'PAID',
      refundStatus: 'FULL',
      refundedMinor: 9900,
      refundedUnits: 20,
    });
    expect(
      await prisma.generationWallet.findFirst({ where: { userId, creditType: 'TEXT' } }),
    ).toMatchObject({ available: 0, reserved: 0, debt: 0 });
    const history = await prisma.paymentEvent.findMany({ orderBy: { id: 'asc' } });
    await refundWebhook(result.id).expect(200);
    expect(await prisma.paymentEvent.findMany({ orderBy: { id: 'asc' } })).toEqual(history);
    expect(fetchMock.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
  });

  it('carries fractional partial refunds forward without over-revoking credits', async () => {
    const { orderId, payment } = await paidOrder();
    const tiny = refund(payment.id, '0.01');
    await refundWebhook(tiny.id).expect(200);
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'REFUND' } })).toBe(0);
    expect(
      await prisma.paymentRefund.findUnique({ where: { providerRefundId: tiny.id } }),
    ).toMatchObject({ status: 'SUCCEEDED', compensatedUnits: 0 });
    const half = refund(payment.id, '49.49');
    await refundWebhook(half.id).expect(200);
    expect(await purchases.get(userId, orderId)).toMatchObject({
      refundStatus: 'PARTIAL',
      refundedMinor: 4950,
      refundedUnits: 10,
    });
    const rest = refund(payment.id, '49.50');
    await refundWebhook(rest.id).expect(200);
    expect(await purchases.get(userId, orderId)).toMatchObject({
      refundStatus: 'FULL',
      refundedUnits: 20,
    });
    const sum = await prisma.creditLedgerEntry.aggregate({
      where: { kind: 'REFUND' },
      _sum: { units: true },
    });
    expect(sum._sum.units).toBe(20);
    await refunds.check(userId, orderId);
    expect((await purchases.get(userId, orderId)).refundedUnits).toBe(20);
  });

  it('serializes concurrent partial refunds independently of notification order', async () => {
    const { orderId, payment } = await paidOrder();
    const partials = [
      refund(payment.id, '33.00'),
      refund(payment.id, '33.00'),
      refund(payment.id, '33.00'),
    ];
    const responses = await Promise.all(
      partials.reverse().map((partial) => refundWebhook(partial.id)),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await purchases.get(userId, orderId)).toMatchObject({
      refundStatus: 'FULL',
      refundedMinor: 9900,
      refundedUnits: 20,
    });
    expect(
      (
        await prisma.creditLedgerEntry.aggregate({
          where: { kind: 'REFUND' },
          _sum: { units: true },
        })
      )._sum.units,
    ).toBe(20);
  });

  it('never compensates pending/canceled refunds or regresses a succeeded refund', async () => {
    const { orderId, payment } = await paidOrder();
    const pending = refund(payment.id, '49.50', 'pending');
    await refundWebhook(pending.id).expect(200);
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'REFUND' } })).toBe(0);
    pending.status = 'canceled';
    await refunds.check(userId, orderId);
    expect(
      await prisma.paymentRefund.findUnique({ where: { providerRefundId: pending.id } }),
    ).toMatchObject({ status: 'CANCELLED', compensatedUnits: 0 });
    expect((await purchases.get(userId, orderId)).refundedMinor).toBe(0);
    const success = refund(payment.id, '49.50');
    await refundWebhook(success.id).expect(200);
    success.status = 'pending';
    await refundWebhook(success.id).expect(200);
    expect(
      await prisma.paymentRefund.findUnique({ where: { providerRefundId: success.id } }),
    ).toMatchObject({ status: 'SUCCEEDED', compensatedUnits: 10 });
    expect((await purchases.get(userId, orderId)).refundedMinor).toBe(4950);
  });

  it.each(['amount', 'currency', 'shop', 'live', 'refund-id', 'payment-id', 'payment-pending'])(
    'rejects refund %s mismatch without revoking credits',
    async (mismatch) => {
      const { orderId, payment } = await paidOrder();
      const result = refund(payment.id);
      const expectedId = result.id;
      if (mismatch === 'amount') result.amount.value = '99.01';
      if (mismatch === 'currency') result.amount.currency = 'USD';
      if (mismatch === 'shop') payment.recipient.account_id = 'other-shop';
      if (mismatch === 'live') payment.test = false;
      if (mismatch === 'refund-id') result.id = randomUUID();
      if (mismatch === 'payment-id') result.payment_id = randomUUID();
      if (mismatch === 'payment-pending') {
        payment.status = 'pending';
        payment.paid = false;
      }
      const response = await refundWebhook(expectedId);
      expect(response.status).toBe(mismatch === 'payment-id' ? 503 : 200);
      expect(await prisma.creditLedgerEntry.count({ where: { kind: 'REFUND' } })).toBe(0);
      expect((await purchases.get(userId, orderId)).refundedUnits).toBe(0);
    },
  );

  it('rejects cumulative over-refunds and conflicting amounts for an existing provider ID', async () => {
    const { orderId, payment } = await paidOrder();
    const first = refund(payment.id, '66.00');
    await refundWebhook(first.id).expect(200);
    const over = refund(payment.id, '34.00');
    await refundWebhook(over.id).expect(200);
    expect((await purchases.get(userId, orderId)).refundedMinor).toBe(6600);
    expect(await prisma.paymentRefund.count()).toBe(1);
    first.amount.value = '65.00';
    await refundWebhook(first.id).expect(200);
    expect((await purchases.get(userId, orderId)).refundedMinor).toBe(6600);
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'REFUND' } })).toBe(1);
  });

  it('records spent credits as debt and repays it before making new credits available', async () => {
    const { orderId, payment } = await paidOrder();
    const spend = {
      userId,
      creditType: 'TEXT' as const,
      units: 12,
      operationKey: 'spent-before-refund',
    };
    await wallets.reserve(spend);
    await wallets.commit(spend);
    const result = refund(payment.id);
    await refundWebhook(result.id).expect(200);
    expect(
      await prisma.generationWallet.findFirst({ where: { userId, creditType: 'TEXT' } }),
    ).toMatchObject({ available: 0, reserved: 0, debt: 12 });
    await expect(
      wallets.reserve({ ...spend, units: 1, operationKey: 'new-reserve' }),
    ).rejects.toMatchObject({
      response: { code: 'INSUFFICIENT_TEXT_CREDITS', details: { debt: 12 } },
    });
    await wallets.grant({
      userId,
      creditType: 'TEXT',
      units: 5,
      kind: 'PURCHASE',
      operationKey: 'new-purchase-1',
    });
    expect(
      await prisma.generationWallet.findFirst({ where: { userId, creditType: 'TEXT' } }),
    ).toMatchObject({ available: 0, debt: 7 });
    await wallets.grant({
      userId,
      creditType: 'TEXT',
      units: 10,
      kind: 'PURCHASE',
      operationKey: 'new-purchase-2',
    });
    expect(
      await prisma.generationWallet.findFirst({ where: { userId, creditType: 'TEXT' } }),
    ).toMatchObject({ available: 3, debt: 0 });
    await payments.check(userId, orderId);
    expect(
      await prisma.creditLedgerEntry.count({ where: { operationKey: `purchase:${orderId}` } }),
    ).toBe(1);
    expect(
      await prisma.generationWallet.findFirst({ where: { userId, creditType: 'TEXT' } }),
    ).toMatchObject({ available: 3, debt: 0 });
  });

  it.each(['release', 'commit'] as const)(
    'preserves active reserves across a refund and settles %s once',
    async (settle) => {
      const { payment } = await paidOrder();
      const held = { userId, creditType: 'TEXT' as const, units: 4, operationKey: 'held-refund' };
      await wallets.reserve(held);
      const result = refund(payment.id);
      await refundWebhook(result.id).expect(200);
      expect(
        await prisma.generationWallet.findFirst({ where: { userId, creditType: 'TEXT' } }),
      ).toMatchObject({ available: 0, reserved: 4, debt: 4 });
      await wallets[settle](held);
      await wallets[settle](held);
      expect(
        await prisma.generationWallet.findFirst({ where: { userId, creditType: 'TEXT' } }),
      ).toMatchObject({ available: 0, reserved: 0, debt: settle === 'release' ? 0 : 4 });
    },
  );

  it('does not create usable credits when reserve races with full refund', async () => {
    const { payment } = await paidOrder();
    const result = refund(payment.id);
    const held = { userId, creditType: 'TEXT' as const, units: 20, operationKey: 'racing-refund' };
    const outcomes = await Promise.allSettled([wallets.reserve(held), refunds.webhook(result.id)]);
    expect(outcomes[1]?.status).toBe('fulfilled');
    const wallet = await prisma.generationWallet.findFirstOrThrow({
      where: { userId, creditType: 'TEXT' },
    });
    expect(wallet.available).toBe(0);
    expect(wallet.available + wallet.reserved - wallet.debt).toBe(0);
    if (outcomes[0]?.status === 'fulfilled') await wallets.release(held);
    expect(
      await prisma.generationWallet.findFirst({ where: { userId, creditType: 'TEXT' } }),
    ).toMatchObject({ available: 0, reserved: 0, debt: 0 });
  });

  it('rolls back partial compensation and recovers a missed webhook through paginated reconciliation', async () => {
    const { orderId, payment } = await paidOrder();
    const first = refund(payment.id, '49.50');
    refund(payment.id, '49.50');
    refundPageSize = 1;
    const original = wallets.compensateRefund.bind(wallets);
    const failure = vi
      .spyOn(wallets, 'compensateRefund')
      .mockImplementationOnce(async (input, database) => {
        await original(input, database);
        throw new Error('Crash after refund ledger insertion');
      });
    await refundWebhook(first.id).expect(500);
    failure.mockRestore();
    expect(await prisma.paymentRefund.count()).toBe(0);
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'REFUND' } })).toBe(0);
    expect((await purchases.get(userId, orderId)).refundedMinor).toBe(0);
    expect(await refunds.reconcile()).toEqual({ scanned: 1, checked: 1, failed: 0 });
    expect((await purchases.get(userId, orderId)).refundStatus).toBe('FULL');
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'REFUND' } })).toBe(2);
    expect(await refunds.reconcile()).toEqual({ scanned: 1, checked: 1, failed: 0 });
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'REFUND' } })).toBe(2);
  });

  it('keeps failed provider reads retryable and processes pending refunds only after success', async () => {
    const { orderId, payment } = await paidOrder();
    const result = refund(payment.id, '99.00', 'pending');
    failRefundReads = true;
    await refundWebhook(result.id).expect(503);
    expect(await refunds.reconcile()).toEqual({ scanned: 1, checked: 0, failed: 1 });
    failRefundReads = false;
    await refunds.check(userId, orderId);
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'REFUND' } })).toBe(0);
    result.status = 'succeeded';
    await refunds.reconcile();
    expect((await purchases.get(userId, orderId)).refundStatus).toBe('FULL');
  });

  it('owns refund endpoints and never stores raw refund payloads', async () => {
    const { orderId, payment } = await paidOrder();
    const result = refund(payment.id);
    Object.assign(result, { description: 'private-refund-description' });
    const otherId = '99887777';
    await app.get(IdentityService).resolveBotUser({ telegramUserId: otherId });
    fetchMock.mockClear();
    await signed('GET', `/api/v1/purchase-orders/${orderId}/refunds`, undefined, otherId).expect(
      404,
    );
    await signed(
      'POST',
      `/api/v1/purchase-orders/${orderId}/refunds/check`,
      undefined,
      otherId,
    ).expect(404);
    expect(fetchMock).not.toHaveBeenCalled();
    await signed('POST', `/api/v1/purchase-orders/${orderId}/refunds/check`).expect(200);
    const response = await signed('GET', `/api/v1/purchase-orders/${orderId}/refunds`).expect(200);
    expect(response.body).toMatchObject({
      data: [{ status: 'SUCCEEDED', amountMinor: 9900, compensatedUnits: 20 }],
    });
    expect(JSON.stringify(await prisma.paymentEvent.findMany())).not.toContain(
      'private-refund-description',
    );
    const walletResponse = await signed('GET', '/api/v1/wallets').expect(200);
    const walletBody = walletResponse.body as { data: { creditType: string; debt: number }[] };
    expect(walletBody.data.find((wallet) => wallet.creditType === 'TEXT')).toMatchObject({
      debt: 0,
    });
  });
  it('roundtrips the refund migration without changing the legacy order snapshot', async () => {
    const initial = await order();
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        DROP TABLE "PaymentRefund";
        ALTER TABLE "PurchaseOrder" DROP COLUMN "refundedMinor", DROP COLUMN "refundedUnits", DROP COLUMN "refundsCheckedAt";
        ALTER TABLE "GenerationWallet" DROP COLUMN "debt";
        DROP TYPE "RefundStatus";
      `);
      const snapshot = await client.query<{ priceMinor: number; units: number }>(
        'SELECT "priceMinor", "units" FROM "PurchaseOrder" WHERE id = $1',
        [initial.id],
      );
      expect(snapshot.rows).toEqual([{ priceMinor: 9900, units: 20 }]);
      await client.query(
        await readFile(
          'prisma/migrations/20261020120000_refund_compensation/migration.sql',
          'utf8',
        ),
      );
      const upgraded = await client.query<{ refundedMinor: number; refundedUnits: number }>(
        'SELECT "refundedMinor", "refundedUnits" FROM "PurchaseOrder" WHERE id = $1',
        [initial.id],
      );
      expect(upgraded.rows).toEqual([{ refundedMinor: 0, refundedUnits: 0 }]);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
    expect((await purchases.get(userId, initial.id)).priceMinor).toBe(9900);
  });

  it('recovers a succeeded refund arriving before the original payment was fulfilled', async () => {
    const initial = await order();
    lostResponse = true;
    await expect(payments.create(userId, initial.id)).rejects.toThrow();
    const payment = [...providerPayments.values()][0];
    if (!payment) throw new Error('Missing provider fixture');
    payment.status = 'succeeded';
    payment.paid = true;
    const result = refund(payment.id);
    await refundWebhook(result.id).expect(200);
    expect(await purchases.get(userId, initial.id)).toMatchObject({
      status: 'PAID',
      fulfillmentStatus: 'FULFILLED',
      refundStatus: 'FULL',
      refundedUnits: 20,
    });
    expect(
      await prisma.generationWallet.findFirst({ where: { userId, creditType: 'TEXT' } }),
    ).toMatchObject({ available: 0, debt: 0 });
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'PURCHASE' } })).toBe(1);
    expect(await prisma.creditLedgerEntry.count({ where: { kind: 'REFUND' } })).toBe(1);
  });
});
