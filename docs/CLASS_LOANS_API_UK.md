# Видача примірників на класи: API-контракт

Цей контур зберігає пакетну видачу на клас окремо від чинних видач учителям. Кожна видача фіксує незмінний ідентифікатор відповідального вчителя та його ім’я в аудиті, тому подальша зміна класного керівника не стирає відповідальність за історичну операцію.

Усі endpoint-и вимагають авторизованого бібліотекаря або адміністратора. `POST` додатково вимагає ввімкнених виробничих записів, same-origin запиту та JSON без зайвих полів. Кожна мутація використовує UUID `requestId`; безпечний повтор того самого запиту повертає попередній результат і не дублює рух.

## Довідники для форми

- `GET /api/librarian/academic-reference` — активні навчальні роки й `classYears`; форма передає `classYearId` та поточний `version` як `expectedClassYearVersion`.
- `GET /api/librarian/library-reference` — активні вчителі й дозволені місця; форма передає вибраний `responsibleTeacherUserId`.
- Якщо в активного класу є чинний класний керівник, інтерфейс може вибрати його за замовчуванням. Сервер усе одно перевіряє, що переданий профіль учителя активний.

## Відкриті видачі

`GET /api/librarian/class-loans?classYearId=<optional>&limit=<1..200>`

Без `limit` повертається до 100 відкритих видач. `classYearId` необов’язковий. Відповідь:

```json
{
  "schemaVersion": 1,
  "success": true,
  "classLoans": [
    {
      "classLoanId": "CLOAN-...",
      "classYearId": "CY-...",
      "className": "5-А клас",
      "academicYearId": "YR-...",
      "academicYearLabel": "2026/2027",
      "cohortId": "COH-...",
      "responsibleTeacherUserId": "USR-...",
      "responsibleTeacherName": "Ім’я вчителя",
      "status": "open",
      "issuedAt": "2026-09-10",
      "dueAt": "2027-06-30",
      "notes": "",
      "version": 1,
      "items": [
        {
          "classLoanItemId": "CLI-...",
          "materialId": "CAT-0001",
          "materialTitle": "Назва",
          "materialYear": 2024,
          "sourceLocationId": "LOC-001",
          "sourceLocationName": "Бібліотека",
          "condition": "good",
          "quantityIssued": 25,
          "quantityReturned": 5,
          "quantityOutstanding": 20
        }
      ]
    }
  ],
  "writesEnabled": true
}
```

## Оформлення видачі

`POST /api/librarian/class-loans`

```json
{
  "requestId": "20000000-0000-4000-8000-000000000001",
  "classYearId": "CY-...",
  "expectedClassYearVersion": 1,
  "responsibleTeacherUserId": "USR-...",
  "issuedAt": "2026-09-10",
  "dueAt": "2027-06-30",
  "notes": null,
  "items": [
    {
      "materialId": "CAT-0001",
      "sourceLocationId": "LOC-001",
      "condition": "good",
      "quantity": 25,
      "expectedAvailableQuantity": 30
    }
  ]
}
```

`items` містить від 1 до 100 унікальних позицій. `condition`: `unspecified`, `good`, `worn` або `damaged`. `issuedAt` мусить належати датам обраного `classYear`; необов’язковий `dueAt` не може передувати видачі або бути пізнішим за завершення року класу. Успіх має HTTP 201:

```json
{
  "success": true,
  "result": {
    "classLoanId": "CLOAN-...",
    "status": "open",
    "classYearId": "CY-...",
    "responsibleTeacherUserId": "USR-...",
    "responsibleTeacherName": "Ім’я вчителя",
    "issuedAt": "2026-09-10",
    "dueAt": "2027-06-30",
    "closedAt": null,
    "version": 1,
    "transactionId": "CLTX-...",
    "items": [
      {
        "classLoanItemId": "CLI-...",
        "materialId": "CAT-0001",
        "quantityIssued": 25,
        "quantityReturned": 0
      }
    ]
  },
  "writesEnabled": true
}
```

## Часткове або повне повернення

`POST /api/librarian/class-loans/returns`

```json
{
  "requestId": "20000000-0000-4000-8000-000000000002",
  "classLoanId": "CLOAN-...",
  "expectedVersion": 1,
  "returnedAt": "2026-10-01",
  "notes": null,
  "items": [
    {
      "classLoanItemId": "CLI-...",
      "quantity": 5,
      "returnLocationId": "LOC-001",
      "condition": "good"
    }
  ]
}
```

Відповідь має ту саму форму `result`, що й видача. Після часткового повернення `status` лишається `open`; після повернення всіх примірників стає `closed`, заповнюється `closedAt`, а `version` збільшується. `returnedAt` не може передувати даті видачі або найпізнішому вже збереженому поверненню.

## Конфлікти та гарантії

Основні коди, які інтерфейс має показувати без заміни на загальну помилку:

- `validation_failed` — поля або кількість позицій некоректні;
- `class_year_not_found`, `class_year_not_active`, `class_year_version_conflict`;
- `responsible_teacher_not_found`;
- `issue_date_outside_class_year`, `due_date_outside_class_year`;
- `stock_quantity_conflict`, `insufficient_stock`;
- `class_loan_not_found`, `class_loan_already_closed`, `class_loan_version_conflict`;
- `class_loan_item_not_found`, `return_quantity_exceeds_outstanding`;
- `return_date_invalid`, `return_date_before_previous_return`;
- `location_not_found`, `class_loan_return_conflict`;
- `request_id_conflict`, `mutation_in_progress`;
- `class_has_open_loans` — клас не можна закрити або перевести на новий рік до повного повернення.

Видача й повернення виконуються одним атомарним D1 batch: при конфлікті не зберігається ані часткова кількість, ані команда, ані аудит. Матеріал, джерело та місце повернення повторно перевіряються всередині batch. Агреговані залишки враховують відкриті видачі і вчителям, і класам. Пакет зі 100 позицій обробляється сталою кількістю JSON1-запитів і не залежить лінійно від кількості назв.
