# Заявки вчителів на матеріали

Серверний контур використовує наявну кодову сесію вчителя, D1 та єдині
журнали мутацій. Усі відповіді приватні (`no-store`) і мають
`schemaVersion: 1`.

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

Усі ці маршрути закриваються прапорцем `TEACHER_PORTAL_ENABLED`, перевіряють
кодову cookie-сесію та для запису вимагають той самий origin.

## Маршрути бібліотекаря

- `GET /api/librarian/material-requests` — черга й `newCount`.
- `GET /api/librarian/material-requests/locations` — активні публічні місця
  отримання.
- `PATCH /api/librarian/material-requests/:id` — одна з дій:
  `start_review`, `ready`, `complete`, `reject`.

Дія `ready` приймає місце отримання, необов’язкову дату повернення та від 1 до
10 фактично підготовлених позицій:

```json
{
  "requestId": "UUID",
  "expectedVersion": 2,
  "action": "ready",
  "pickupLocationId": "LOC-205",
  "dueAt": "2026-09-30",
  "items": [
    {
      "itemId": "MRI-...",
      "approvedQuantity": 2,
      "sourceLocationId": "LOC-LIB",
      "condition": "good",
      "expectedAvailableQuantity": 5
    }
  ]
}
```

Пропущені позиції отримують схвалену й виконану кількість `0`. Статус буде
`ready`, лише якщо всі позиції підготовлено повністю; інакше —
`partially_ready`.

## Гарантії запису

- `requestId` забезпечує точне повторне відтворення завершеної відповіді й не
  дозволяє повторно використати UUID з іншим тілом або користувачем.
- `expectedVersion` захищає від паралельного редагування.
- `ready` одним D1 batch створює видачу, її позиції, рух запасу, оновлює
  залишки, заявку, подію, аудит і сповіщення. Конфлікт залишку відкочує весь
  batch.
- `complete` лише завершує робочий процес заявки й не змінює запаси повторно.
- Кількість позицій обмежена десятьма, а batch — менше ніж 43 операціями.
