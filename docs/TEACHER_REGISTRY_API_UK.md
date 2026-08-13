# Реєстр учителів у кабінеті бібліотекаря

Усі маршрути доступні лише бібліотекарю. Записи додатково вимагають увімкнених змін і запиту з того самого сайту. Email та табельний номер не є полями картки вчителя.

## Перелік

`GET /api/librarian/teachers?status=active|inactive|all&attention=all|orders|overdue|visits|access&q=&limit=30&cursor=`

Відповідь містить `counters`/`summary`, сторінку `teachers`, активні `locations` і непрозорий `page.nextCursor`. Лічильники рахуються незалежно від сторінки. Пошук працює за нормалізованим ПІБ, а не за SQLite `lower()`, який не підтримує український регістр.

`GET /api/librarian/teachers/:id` повертає повну картку, класи, майбутні відвідування, заявки з матеріалами, особисті та класні видачі, сповіщення, журнал і `dependencySummary`.

## Створення і редагування

`POST /api/librarian/teachers` приймає точне тіло:

```json
{
  "requestId": "UUID",
  "fullName": "ПІБ",
  "subjectPosition": "",
  "primaryLocationId": null,
  "serviceContact": "",
  "librarianNote": "",
  "forceDuplicate": false
}
```

Однакове нормалізоване ПІБ повертає `409 teacher_duplicate_warning`; усвідомлене повторення можливе з `forceDuplicate:true`.

`PATCH /api/librarian/teachers/:id` приймає `{requestId,expectedVersion,action,changes,reason,forceDuplicate}`. `action` — `update`, `close` або `restore`. Закриття й відновлення передають `changes:{}`.

Закриття блокується (`teacher_close_blocked`), доки є активні заявки, майбутні активні відвідування або чинні/заплановані класи. Відкриті видачі не видаляються і можуть бути повернуті після закриття. Успішне закриття вимикає credential та відкликає всі teacher sessions; відновлення не вмикає старий код автоматично.

## Видалення

`DELETE /api/librarian/teachers/:id` приймає `{requestId,expectedVersion,confirmation:"DELETE_EMPTY_TEACHER"}`. Видалення дозволено лише для справді порожньої помилкової картки без кодів, сеансів, відвідувань, заявок, видач, класів, сповіщень або акторських посилань. Усі інші картки можна лише закрити. Запис журналу про видалену картку не має FK на самого вчителя і зберігається.

Усі зміни мають ідемпотентний `requestId`, перевірку `expectedVersion`, атомарний fail-closed guard і audit event. Повтор того самого запиту повертає попередній результат; інше тіло з тим самим `requestId` повертає `request_id_conflict`.
