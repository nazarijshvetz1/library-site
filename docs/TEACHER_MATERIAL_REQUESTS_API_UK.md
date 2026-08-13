# Заявки вчителів на матеріали

Серверний контур використовує кодову сесію вчителя, D1 та єдині журнали
мутацій. Усі відповіді приватні (`no-store`) і мають `schemaVersion: 1`.

## Маршрути вчителя

- `GET /api/teacher/material-requests?limit=50` — власні заявки.
- `POST /api/teacher/material-requests` — створення заявки:
  `{ requestId, notes, items: [{ materialId, quantity }] }`.
- `DELETE /api/teacher/material-requests/:id` — скасування власної заявки у
  стані `submitted` або `in_review`:
  `{ requestId, expectedVersion, reason }`.
- `GET /api/teacher/notifications?limit=50` — власні сповіщення.
- `PATCH /api/teacher/notifications/:id` — позначення прочитаним:
  `{ requestId, expectedVersion, read: true }`.

Маршрути закриваються прапорцем `TEACHER_PORTAL_ENABLED`, перевіряють кодову
cookie-сесію та для запису вимагають той самий origin.

## Маршрути бібліотекаря

- `GET /api/librarian/material-requests` — черга й `newCount`.
- `GET /api/librarian/material-requests/locations` — активні публічні місця
  отримання.
- `PATCH /api/librarian/material-requests/:id` — дія `start_review`, `ready`,
  `issue`, `release`, сумісна дія `complete` або `reject`.

### 1. Підготувати й зарезервувати

`ready` не створює позику і не змінює фізичний рядок `holdings`. Поле
`approvedQuantity` є кумулятивною цільовою кількістю позиції, а
`expectedAvailableQuantity` — поточною вільною кількістю
`physical - active reservations`. Сервер резервує лише різницю між новою
ціллю та вже схваленою кількістю.

```json
{
  "requestId": "UUID",
  "expectedVersion": 2,
  "action": "ready",
  "pickupLocationId": "LOC-205",
  "dueAt": "2026-09-30",
  "items": [{
    "itemId": "MRI-...",
    "approvedQuantity": 2,
    "sourceLocationId": "LOC-LIB",
    "condition": "good",
    "expectedAvailableQuantity": 5
  }]
}
```

Підготовку можна доповнювати у станах `ready` і `partially_ready`. Зменшення
резерву виконується тільки через `release`, щоб історія залишалася незмінною.

### 2. Фактично видати

`issue` приймає одну або кілька активних частин резерву. Лише ця дія створює
або доповнює відкриту позику вчителя, створює рух `loan_issue` та зменшує
фізичний залишок. Часткова видача лишає заявку підготовленою; коли активного
резерву не лишилося, заявка стає `completed`.

```json
{
  "requestId": "UUID",
  "expectedVersion": 3,
  "action": "issue",
  "issuedAt": "2026-08-13",
  "dueAt": "2026-09-30",
  "items": [{ "reservationId": "MRR-...", "quantity": 1 }]
}
```

Дата видачі не може бути майбутньою, а дата повернення — ранішою за неї.
Сумісна дія `complete` фізично видає весь активний резерв поточною київською
датою; новий інтерфейс має надсилати явну дію `issue`.

Для заявок зі станом `ready`/`partially_ready`, створених до запровадження
резервів, позика й рух залишків уже були записані. Якщо така заявка має
`resultingLoanId`, але не має рядків резерву, `complete` лише підтверджує
фізичне отримання і не списує запас повторно. Міграція переносить строк
повернення з наявної позики, а інтерфейс показує окрему підтверджувальну дію.

### 3. Не забрано / звільнити резерв

`release` частково або повністю звільняє активний резерв без руху запасу і без
створення позики.

```json
{
  "requestId": "UUID",
  "expectedVersion": 3,
  "action": "release",
  "reason": "Замовлення не забрали вчасно",
  "items": [{ "reservationId": "MRR-...", "quantity": 1 }]
}
```

Якщо після звільнення не лишилося ні резерву, ні фактично виданих примірників,
заявка стає `cancelled`. Якщо частину вже видано — `completed`.

## Проєкція і доступність

У заявці повертається `dueAt`. Кожна позиція має `reservedQuantity` та:

```json
{
  "reservations": [{
    "id": "MRR-...",
    "sourceLocationId": "LOC-LIB",
    "sourceLocationName": "Бібліотека",
    "condition": "good",
    "reservedQuantity": 2,
    "issuedQuantity": 1,
    "releasedQuantity": 0,
    "remainingQuantity": 1
  }]
}
```

Каталог віднімає активний резерв із `availableQuantity`. Для місця зберігання
сервер повертає `physicalQuantity`, `reservedQuantity`, `availableQuantity`, а
сумісне поле `quantity` теж означає вільну, а не фізичну кількість. Прямі
видачі вчителю, видачі класу, переміщення, списання та інвентаризація не можуть
використати зарезервовані примірники.

## Атомарність і захист від перегонів

- `requestId` і `expectedVersion` забезпечують ідемпотентність та оптимістичне
  блокування.
- Резерви зберігаються у `material_request_reservations`; кількість резерву
  незмінна, а `issuedQuantity` і `releasedQuantity` можуть лише зростати.
- D1-тригери не дозволяють сукупному активному резерву перевищити фізичний
  залишок, зменшити/видалити holding нижче резерву або архівувати
  зарезервований матеріал.
- Деактивація матеріалу чи місця між перевіркою і batch блокує фізичну видачу,
  але не заважає безпечно звільнити резерв.
- Уся видача/звільнення, подія, аудит, сповіщення, команда та перерахунок
  залишку відбуваються одним D1 batch. Максимум — 10 позицій і не більш як 50
  операторів.

Основні конфлікти повертають HTTP 409: `request_version_conflict`,
`reservation_stock_conflict`, `reserved_stock_conflict`,
`reservation_quantity_exceeded`, `request_loan_closed`. Некоректні дати
повертають HTTP 400: `invalid_issue_date`, `invalid_due_date`.

Міграція `0010` зберігає чинні заявки, позиції, події та старі пов’язані
позики з увімкненими FK, додає резерви й перевіряється через
`PRAGMA foreign_key_check`.
