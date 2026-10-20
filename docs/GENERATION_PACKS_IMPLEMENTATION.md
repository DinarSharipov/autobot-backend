# Реализация prepaid generation packs

Этот документ превращает [продуктовое решение](GENERATION_PACKS_PLAN.md) в план работ для
backend. Он не меняет контракт: до отдельного релиза legacy-подписки и месячные квоты остаются
действующим production-поведением.

## Статус реализации

В коде выполнен первый additive-этап: Prisma-схема и миграция, read-only API каталога и кошелька,
append-only ledger и транзакционный `WalletService` для idempotent grant/reserve/commit/release.
`PREPAID_GENERATION_ENABLED` по умолчанию равен `false`, поэтому текущий production write-path
подписок и monthly quotas остаётся активным.

Создание idempotent purchase order со snapshot пакета и цены также реализовано; заказ остаётся
`PENDING` и не пополняет кошелёк. Каталог provision-ится повторяемо при миграционном деплое. Production checkout и переключение
generation pipeline требуют отдельного решения и acceptance.

Тестовый payment lifecycle реализован additive-срезом: создание/проверка платежа, verified webhook,
атомарный grant/fulfillment и явный reconciler CLI. Checkout и webhook по умолчанию выключены;
требуются test shop и allowlist. Актуальный контракт, ограничения и rollout описаны в
[BILLING_TEST_CHECKOUT.md](BILLING_TEST_CHECKOUT.md). Verified refund compensation и политика задолженности описаны в [BILLING_REFUNDS.md](BILLING_REFUNDS.md).
Полный media/revision acceptance и production Stars остаются следующими срезами.

## Что заменить

| Текущий контур                                           | Новая ответственность                             | Изменение                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SubscriptionPlan`, `Subscription`, `EntitlementService` | Глобальные лимиты каналов и тем                   | Вынести caps в server configuration; перестать выбирать их по тарифу.                                         |
| `UsageCounter`, `UsageLedgerEntry`, `UsageService`       | История legacy-использования                      | Не удалять в первой миграции; прекратить использовать для новых generation-команд после feature-flag cutover. |
| `UsageMetric.MODERATION_REVISION`                        | Три включённые ревизии и платные последующие      | Заменить allowance, связанный с конкретной `Publication`, а не с `Post` или месяцем.                          |
| Резервация при immediate/schedule materialization        | Резервация непосредственно перед вызовом GPTunnel | Не блокировать баланс при создании Post/Schedule; планировщик создаёт occurrence без списания.                |
| Image generation в `PublishingService`                   | Выбранный media-артефакт и IMAGE debit            | Генерировать/резервировать до preview, хранить только Telegram `file_id` и метаданные версии.                 |

## Целевая схема Prisma

Добавить enums `CreditType` (`TEXT`, `IMAGE`), `CreditLedgerKind` (`GIFT`, `PURCHASE`,
`RESERVE`, `COMMIT`, `RELEASE`, `REFUND`, `ADJUSTMENT`), `ReservationStatus`,
`PurchaseOrderStatus`, `PaymentEventStatus` и `MediaStatus`.

Добавить модели:

- `GenerationWallet`: одна запись на пользователя и тип кредита; поля `available`, `reserved`,
  `version`; unique `(userId, creditType)`.
- `CreditLedgerEntry`: append-only запись c `walletId`, `kind`, `units`, `operationKey`, ссылками
  на `Publication`/`PurchaseOrder` и snapshot metadata; unique `(walletId, operationKey)`.
- `GenerationReservation`: явная связь reserve → commit/release c `operationKey`, статусом,
  кредитным типом и владельцем операции; unique `operationKey`.
- `TextRevisionAllowance`: `userId`, `publicationId`, `includedTotal=3`,
  `includedCommitted`, `includedReserved`; unique `publicationId`.
- `GenerationPack`: server-controlled catalog entry с типом, units, суммой в minor RUB,
  валютой, версией, активностью и snapshot-versioning.
- `PurchaseOrder`: user, snapshot pack/price/currency, idempotency key, status, provider id,
  payment URL and expiry. Цена не должна зависеть от текущего каталога после создания order.
- `PaymentEvent`: неизменяемый журнал webhook/poll событий с unique provider event ID и
  проверенным payload hash.
- `PublicationMedia`: одна или несколько image-версий occurrence: Telegram preview message/file
  reference, status, approval/version timestamps. Не хранить bytes, base64, provider URL или путь.

Изменить `Publication`: добавить generation group/состояние недостатка средств, выбранный media
reference и optimistic version. `PostVersion` остаётся текстовым артефактом; не использовать его
для счётчика включённых ревизий.

Миграции выполнять additive. В первой миграции не удалять legacy таблицы и не конвертировать
месячные остатки в кредиты. Отдельная административно утверждённая conversion policy обязательна
до любой выдачи стартовых/компенсационных балансов.

## Новый сервисный контур

Создать `billing`/`generation-packs` модуль вместо расширения `subscriptions`:

- `WalletService`: serializable reserve/commit/release, balance view и идемпотентность ledger.
- `GenerationPricingService`: определяет initial text, included revision, paid revision и image
  replacement; возвращает server-authoritative cost preview.
- `RevisionAllowanceService`: резервирует либо одну included revision, либо TEXT credit только
  после явного `costConfirmation` от клиента. При гонке возвращает актуальный preview, не меняет
  тип списания сам.
- `PurchaseService` и `YooKassaAdapter`: создают order, проверяют webhook и зачисляют pack в той
  же транзакции, что переводят order в paid. Redirect клиента не является подтверждением.
- `ReservationReconciler`: находит застрявшие reserve по durable `AIRequest`/`Publication` и
  завершает commit/release без вызова провайдера внутри транзакции.

`UsageService` не должен использоваться новой логикой. Его удаление, а также `/subscription` и
`/usage`, допускается только после миграции bot-клиента и окончания периода совместимости.

## Изменения pipeline

1. `PostsService` и `SchedulesService` создают только occurrence/outbox. Они не резервируют TEXT
   или IMAGE при создании публикации.
2. `GenerationService.claim` перед GPTunnel резервирует 1 TEXT для initial generation. После
   успешного accepted text — commit и создание `TextRevisionAllowance(3)` в той же транзакции;
   terminal failure — release. Повтор job использует ту же reservation.
3. `ModerationService.revision` получает preview стоимости. Включённая ревизия резервирует
   allowance; четвёртая и следующие требуют подтверждённый TEXT reserve. Commit происходит только
   после валидного результата AI.
4. Для image flow выделить generation/preview job. Он резервирует 1 IMAGE, создаёт private
   Telegram preview, сохраняет только file_id/message reference и commit после accepted preview.
   MODERATION требует выбрать/одобрить image перед финальной отправкой. `PublishingService`
   переиспользует file_id и не вызывает image provider при delivery retry.
5. `PublicationDispatcherService` получает состояния `BLOCKED_FUNDS`/resume. После пополнения
   пользователь или безопасный reconciler возобновляет ту же occurrence; scheduler не создаёт
   повторные occurrence и не списывает за неё повторно.

## API и OpenAPI

Добавить version-compatible endpoints:

- `GET /generation-packs`, `GET /wallets`, `GET /wallets/ledger`;
- `POST /purchase-orders`, `GET /purchase-orders/:id`, `POST /payments/yookassa/webhook`;
- `POST /publications/:id/generation-cost-preview`, `POST /moderation/:id/revision` с
  `costConfirmationId`;
- image preview/replacement/select endpoints с ownership checks и optimistic version.

Возвращать machine-readable `INSUFFICIENT_TEXT_CREDITS`, `INSUFFICIENT_IMAGE_CREDITS`,
`COST_CONFIRMATION_REQUIRED`, `STALE_COST_CONFIRMATION`, `PAYMENT_NOT_CONFIRMED` и
`MEDIA_UNAVAILABLE`. `GET /subscription` и `GET /usage` оставить read-only legacy до миграции
клиентов, пометив deprecated в OpenAPI.

## Cutover и проверка

1. Сначала выпустить additive schema, read-only catalogue/wallet API и feature flag
   `PREPAID_GENERATION_ENABLED=false`.
2. Провести dry-run миграции на snapshot production: инвентаризация subscriptions/counters/in-flight
   jobs, проверка foreign keys, план rollback и ручное решение по conversion policy.
3. Onboarding gift выдаётся идемпотентно при первом чтении кошелька (`GET /wallets`): две записи
   `GIFT` имеют стабильные operation keys, поэтому повторные запросы не начисляют кредиты второй раз.
   В login handler эта логика не вызывается.
4. Перевести новый bot-клиент на preview/confirmation и wallet API; затем включить flag для
   ограниченной группы пользователей.
5. Добавить unit, integration, webhook-contract и acceptance случаи: последний credit, три
   включённые ревизии, конкурирующая четвёртая ревизия, duplicate webhook, month boundary,
   recurrent occurrence, provider failure, delivery retry, image preview/reuse и forged callback.
6. Перед глобальным cutover подтвердить backup/restore, reconciliation и rollback без двойного
   charging. После согласованного периода совместимости удалить legacy write-path отдельной
   миграцией/release.

## Внешние зависимости и решения до начала кода

- YooKassa shop ID, secret key, webhook URL, supported payment methods и refund policy.
- Утверждённая conversion policy для существующих пользователей; по текущему решению автоматическая
  конвертация запрещена.
- Точный UX подтверждения платной ревизии и image replacement в Telegram bot.
- Канал/чат для private image preview и срок жизни/обработка потери Telegram file_id.
- Политика provider-cost accounting, налогов и комиссий: пользовательский credit ledger и расходы
  GPTunnel должны оставаться раздельными.

## Канал оплаты

Для тестового checkout реализован YooKassa redirect lifecycle и конфигурация return URL,
но production checkout выключен. Решение о production-канале (YooKassa redirect или Telegram Stars)
остаётся `pending decision`: до подтверждения требований Telegram для цифровых услуг нельзя включать
YooKassa в production. Redirect URL сам по себе не подтверждает платёж и не начисляет кредиты.
