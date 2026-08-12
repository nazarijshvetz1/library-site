# Прямі операції переміщення та списання

Обидва маршрути працюють без чернеток і записують результат безпосередньо до
D1. Вони доступні лише автентифікованому бібліотекарю або адміністратору,
приймають тільки same-origin POST і відмовляють у записі, якщо
`LIBRARIAN_WRITES_ENABLED` не дорівнює `true`.

Кожен клієнтський намір повинен отримати новий UUID `requestId`. Повтор того
самого тіла з тим самим `requestId` повертає збережений результат без повторної
зміни фонду. Інше тіло з уже використаним `requestId` повертає
`request_id_conflict`.

## Переміщення

`POST /api/librarian/transfers`

```json
{
  "requestId": "123e4567-e89b-42d3-a456-426614174000",
  "materialId": "CAT-1279",
  "sourceLocationId": "LOC-001",
  "destinationLocationId": "LOC-002",
  "condition": "good",
  "quantity": 3,
  "expectedSourceQuantity": 8,
  "expectedDestinationQuantity": 2,
  "occurredAt": "2026-08-12",
  "documentNumber": "Накладна 8",
  "notes": null
}
```

Дозволені `condition`: `unspecified`, `good`, `worn`, `damaged`. Кількість —
ціле число від 1 до 1 000 000. Початкове й кінцеве місця мають відрізнятися,
бути активними та не бути службовими. Обидва очікувані залишки обов’язкові:
вони захищають від втрати паралельної зміни.

Успіх: HTTP 201.

```json
{
  "success": true,
  "result": {
    "materialId": "CAT-1279",
    "sourceLocationId": "LOC-001",
    "destinationLocationId": "LOC-002",
    "condition": "good",
    "quantityMoved": 3,
    "sourceQuantityBefore": 8,
    "sourceQuantityAfter": 5,
    "sourceHoldingVersion": 4,
    "destinationQuantityBefore": 2,
    "destinationQuantityAfter": 5,
    "destinationHoldingVersion": 2,
    "transactionId": "TX-...",
    "occurredAt": "2026-08-12"
  },
  "writesEnabled": true
}
```

Якщо початковий holding спорожнів, `sourceHoldingVersion` дорівнює `null`, бо
рядок holding видалено. Одна D1-транзакція створює дві ledger-лінії: від’ємну
для початкового місця та додатну для кінцевого. Загальний фонд матеріалу не
змінюється.

## Списання

`POST /api/librarian/writeoffs`

```json
{
  "requestId": "123e4567-e89b-42d3-a456-426614174001",
  "materialId": "CAT-1279",
  "locationId": "LOC-002",
  "condition": "damaged",
  "quantity": 2,
  "expectedQuantity": 4,
  "reason": "damaged",
  "occurredAt": "2026-08-12",
  "documentNumber": "Акт 4",
  "notes": null
}
```

Дозволені `reason`: `worn`, `damaged`, `lost`, `obsolete`,
`inventory_shortage`, `other`. Для `other` пояснення в `notes` обов’язкове. Місце має бути активним і
не службовим. `expectedQuantity` є обов’язковим optimistic-lock значенням.

Успіх: HTTP 201.

```json
{
  "success": true,
  "result": {
    "materialId": "CAT-1279",
    "locationId": "LOC-002",
    "condition": "damaged",
    "quantityBefore": 4,
    "quantityWrittenOff": 2,
    "quantityAfter": 2,
    "holdingVersion": 6,
    "transactionId": "TX-...",
    "occurredAt": "2026-08-12"
  },
  "writesEnabled": true
}
```

Якщо списано весь залишок, `holdingVersion` дорівнює `null`. Одна
D1-транзакція зменшує holding, створює від’ємну ledger-лінію, перебудовує
`material_stock_totals`, додає audit event і завершує idempotency command.

## Стабільні помилки

- HTTP 400 `validation_failed` — невідоме поле, некоректний ID, дата,
  кількість, причина або однакові місця переміщення;
- HTTP 403 `cross_origin_request` або `actor_not_mapped`;
- HTTP 404 `material_not_found`, `location_not_found`,
  `source_location_not_found`, `destination_location_not_found`;
- HTTP 409 `stock_quantity_conflict` — фактичний залишок відрізняється від
  очікуваного або змінився під час атомарного запису;
- HTTP 409 `insufficient_stock` — списання чи переміщення перевищує доступний
  залишок;
- HTTP 409 `request_id_conflict` або `mutation_in_progress`;
- HTTP 503 `writes_disabled`, `transfer_unavailable` або
  `writeoff_unavailable`.

За будь-якого конфлікту D1 batch відкочується цілком: holding, totals,
transaction lines, audit event і mutation command не можуть лишитися
частково записаними.
