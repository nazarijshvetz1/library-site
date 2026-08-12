import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const validation = await import(
  pathToFileURL(path.join(root, "lib/library-write-validation.ts")).href
);

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

test("material edits accept public store links and reject unsafe overposting", () => {
  const valid = validation.validateMaterialUpdateInput({
    requestId: REQUEST_ID,
    expectedVersion: 3,
    changes: {
      title: "Математика — 5 клас",
      publicationYear: 2024,
      links: [
        {
          id: null,
          kind: "store",
          label: "Інформація про видання",
          url: "https://example.com/book",
          isPublic: true,
          sortOrder: 0,
        },
      ],
    },
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.changes.links[0].url, "https://example.com/book");

  const invalid = validation.validateMaterialUpdateInput({
    requestId: REQUEST_ID,
    expectedVersion: 3,
    changes: { title: "Назва", catalogNumber: 9999 },
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.fieldErrors["changes.catalogNumber"], /Невідоме/u);
});

test("material links allow only HTTP(S) without embedded credentials", () => {
  for (const url of ["javascript:alert(1)", "file:///tmp/book.pdf", "https://a:b@example.com/book"]) {
    const result = validation.validateMaterialUpdateInput({
      requestId: REQUEST_ID,
      expectedVersion: 1,
      changes: {
        links: [
          {
            id: null,
            kind: "ebook",
            label: "Читати",
            url,
            isPublic: true,
            sortOrder: 0,
          },
        ],
      },
    });
    assert.equal(result.ok, false, url);
    assert.ok(result.fieldErrors["changes.links.0.url"]);
  }
});

test("new material and receipt validation share the direct stock contract", () => {
  const material = validation.validateMaterialCreateInput({
    requestId: REQUEST_ID,
    title: "Українська мова — 6 клас",
    rubric: "Підручники",
    publicationType: "Підручник",
    subject: "Українська мова",
    classFrom: 6,
    classTo: 6,
    author: "Автор",
    publicationYear: 2025,
    isbn: "9786170000000",
    publisher: "Видавництво",
    notes: null,
    links: [],
    initialReceipt: {
      locationId: "LOC-001",
      condition: "good",
      quantity: 10,
      expectedQuantity: 0,
      occurredAt: "2026-08-11",
      documentNumber: "Накладна 1",
      notes: null,
    },
  });
  assert.equal(material.ok, true);
  assert.equal(material.value.initialReceipt.quantity, 10);

  const receipt = validation.validateReceiptCreateInput({
    requestId: REQUEST_ID,
    materialId: "CAT-1279",
    locationId: "LOC-001",
    condition: "unspecified",
    quantity: 5,
    expectedQuantity: 10,
    occurredAt: "2026-08-11",
    documentNumber: null,
    notes: null,
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.value.expectedQuantity, 10);
});

test("actual stock count permits legacy unspecified condition and zero", () => {
  const result = validation.validateStockAdjustmentInput({
    requestId: REQUEST_ID,
    materialId: "CAT-1279",
    locationId: "LOC-001",
    condition: "unspecified",
    expectedQuantity: 55,
    countedQuantity: 0,
    reason: "inventory_count",
    occurredAt: "2026-08-11",
    notes: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.countedQuantity, 0);
});

test("other stock correction requires an explanatory note", () => {
  const result = validation.validateStockAdjustmentInput({
    requestId: REQUEST_ID,
    materialId: "CAT-1279",
    locationId: "LOC-001",
    condition: "unspecified",
    expectedQuantity: 5,
    countedQuantity: 4,
    reason: "other",
    occurredAt: "2026-08-11",
    notes: null,
  });
  assert.equal(result.ok, false);
  assert.ok(result.fieldErrors.notes);
});

test("transfer validation requires distinct locations and both optimistic quantities", () => {
  const valid = validation.validateStockTransferInput({
    requestId: REQUEST_ID,
    materialId: "CAT-1279",
    sourceLocationId: "LOC-001",
    destinationLocationId: "LOC-002",
    condition: "good",
    quantity: 3,
    expectedSourceQuantity: 8,
    expectedDestinationQuantity: 2,
    occurredAt: "2026-08-11",
    documentNumber: "Накладна 8",
    notes: null,
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.expectedSourceQuantity, 8);
  assert.equal(valid.value.expectedDestinationQuantity, 2);

  const sameLocation = validation.validateStockTransferInput({
    ...valid.value,
    destinationLocationId: "LOC-001",
  });
  assert.equal(sameLocation.ok, false);
  assert.ok(sameLocation.fieldErrors.destinationLocationId);

  const overdrawn = validation.validateStockTransferInput({
    ...valid.value,
    quantity: 9,
  });
  assert.equal(overdrawn.ok, false);
  assert.ok(overdrawn.fieldErrors.quantity);
});

test("writeoff validation requires a bounded quantity and explanation for other", () => {
  const valid = validation.validateStockWriteoffInput({
    requestId: REQUEST_ID,
    materialId: "CAT-1279",
    locationId: "LOC-001",
    condition: "damaged",
    quantity: 2,
    expectedQuantity: 4,
    reason: "damaged",
    occurredAt: "2026-08-11",
    documentNumber: "Акт 4",
    notes: null,
  });
  assert.equal(valid.ok, true);

  const unexplained = validation.validateStockWriteoffInput({
    ...valid.value,
    reason: "other",
    notes: null,
  });
  assert.equal(unexplained.ok, false);
  assert.ok(unexplained.fieldErrors.notes);

  const overdrawn = validation.validateStockWriteoffInput({
    ...valid.value,
    quantity: 5,
  });
  assert.equal(overdrawn.ok, false);
  assert.ok(overdrawn.fieldErrors.quantity);
});

test("teacher loan validation rejects duplicate items and an earlier due date", () => {
  const result = validation.validateLoanCreateInput({
    requestId: REQUEST_ID,
    teacherUserId: "USR-001",
    issuedAt: "2026-08-11",
    dueAt: "2026-08-10",
    notes: null,
    items: [
      {
        materialId: "CAT-1279",
        sourceLocationId: "LOC-001",
        condition: "unspecified",
        quantity: 1,
        expectedAvailableQuantity: 5,
      },
      {
        materialId: "CAT-1279",
        sourceLocationId: "LOC-001",
        condition: "unspecified",
        quantity: 1,
        expectedAvailableQuantity: 5,
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.fieldErrors.dueAt);
  assert.match(result.fieldErrors["items.1"], /двічі/u);
});

test("direct write routes remain authenticated, same-origin and fail closed", () => {
  const materialRoute = fs.readFileSync(
    path.join(root, "app/api/librarian/materials/[id]/route.ts"),
    "utf8",
  );
  const materialCreateRoute = fs.readFileSync(
    path.join(root, "app/api/librarian/materials/route.ts"),
    "utf8",
  );
  const receiptRoute = fs.readFileSync(
    path.join(root, "app/api/librarian/receipts/route.ts"),
    "utf8",
  );
  const stockRoute = fs.readFileSync(
    path.join(root, "app/api/librarian/stock-adjustments/route.ts"),
    "utf8",
  );
  const loanRoute = fs.readFileSync(
    path.join(root, "app/api/librarian/loans/route.ts"),
    "utf8",
  );
  const returnRoute = fs.readFileSync(
    path.join(root, "app/api/librarian/loans/returns/route.ts"),
    "utf8",
  );
  const transferRoute = fs.readFileSync(
    path.join(root, "app/api/librarian/transfers/route.ts"),
    "utf8",
  );
  const writeoffRoute = fs.readFileSync(
    path.join(root, "app/api/librarian/writeoffs/route.ts"),
    "utf8",
  );
  for (const source of [
    materialRoute,
    materialCreateRoute,
    receiptRoute,
    stockRoute,
    loanRoute,
    returnRoute,
    transferRoute,
    writeoffRoute,
  ]) {
    assert.match(source, /authorizeLibrarianApi\(\)/u);
    assert.match(source, /isSameOriginRequest\(request\)/u);
    assert.match(source, /if \(!access\.writesEnabled\)/u);
    assert.match(source, /readDraftJsonBody\(request/u);
  }
});

test("mutation store binds every direct write to idempotency and one D1 batch", () => {
  const source = fs.readFileSync(
    path.join(root, "lib/library-mutation-store.ts"),
    "utf8",
  );
  assert.match(source, /SHA-256/u);
  assert.match(source, /INSERT INTO mutation_commands/u);
  assert.match(source, /request_hash/u);
  assert.match(source, /db\.batch\(statements\)/u);
  assert.match(source, /changes\(\) = 1/u);
  assert.match(source, /stock\.counted/u);
  assert.match(source, /material\.created/u);
  assert.match(source, /stock\.received/u);
  assert.match(source, /stock\.transferred/u);
  assert.match(source, /stock\.written_off/u);
  assert.match(source, /loan\.issued/u);
  assert.match(source, /loan\.returned/u);
  assert.match(source, /loan_item\.returned/u);
});
