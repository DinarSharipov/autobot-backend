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
import { PaymentsService } from '../src/generation-packs/payments.service.js';
import { WalletService } from '../src/generation-packs/wallet.service.js';
import type { YooKassaPayment } from '../src/generation-packs/yookassa.adapter.js';
import { withoutBackgroundJobs } from './support/without-background-jobs.js';
import { cleanTestDatabase } from './support/test-database.js';

describe('test checkout through REST, provider HTTP and PostgreSQL', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let wallets: WalletService;
  let purchases: PurchaseService;
  let config: ConfigService;
  let userId: string;
  let ownerTelegramId: string;
  let lostResponse = false;
  const providerPayments = new Map<string, YooKassaPayment>();
  const attempts = new Map<string, string>();
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
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
    purchases = app.get(PurchaseService);
    wallets = app.get(WalletService);
  });
  beforeEach(async () => {
    await cleanTestDatabase(prisma, process.env.DATABASE_URL ?? '');
    providerPayments.clear();
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
    await Promise.all([wallets.balances(userId), wallets.balances(userId)]);
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
});
