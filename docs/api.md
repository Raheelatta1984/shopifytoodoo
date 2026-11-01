# HTTP API reference

Base URL: `http://<host>:8080`
Authentication: `X-API-Key: <key>` (or `Authorization: Bearer <key>`).

**Public endpoints** (no key): `/` (landing page), `/health`, `/ready`,
`/docs` (Swagger UI) and `/docs/json`.
**Protected endpoints**: everything under `/api/` — a valid key is required.

The OpenAPI document is served at `/docs` (Swagger UI) and `/docs/json`.

## Roles and permissions

| Permission | Roles |
|---|---|
| `order:read` | viewer, operator, approver, integrator, auditor, admin |
| `order:ingest` | operator, integrator, admin |
| `order:validate` | operator, integrator, approver, admin |
| `order:approve` | approver, admin |
| `order:reject` | operator, approver, admin |
| `order:publish` | operator, approver, integrator, admin |
| `order:dmf` | operator, approver, integrator, admin |
| `settings:read` | every role |
| `settings:write` | admin |
| `mapping:read` | viewer, operator, approver, integrator, admin |
| `mapping:write` | integrator, admin |
| `audit:read` | auditor, admin |
| `user:manage` | admin |

## Public endpoints

### `GET /`

The landing page: it describes the service and links to the health probes and
to the documentation.  It is what a browser sees when the deployment URL is
opened.

### `GET /health`

The liveness and dependency probe.

```json
{
  "status": "ok",
  "service": "shopifytoodoo",
  "version": "1.0.0",
  "database": "up",
  "datastore": "postgres",
  "shopify": "configured",
  "odoo": "configured",
  "timestamp": "2026-10-01T09:15:00.000Z"
}
```

`GET /ready` answers `{"ready": true}` when the database answers.

## Orders

### `GET /api/v1/orders`

Query parameters: `status`, `validationStatus`, `approvalStatus`,
`sourceOrderId`, `search`, `limit` (1‑500, default 50), `offset`.

```json
{
  "total": 2,
  "limit": 50,
  "offset": 0,
  "orders": [
    {
      "id": "6b1c…",
      "source": "shopify",
      "sourceOrderId": "1001",
      "sourceOrderName": "#1001",
      "status": "validated",
      "validationStatus": "passed",
      "approvalStatus": "auto_approved",
      "currency": "AUD",
      "total": "79.20",
      "customerEmail": "jane.doe@example.com",
      "financialStatus": "PAID",
      "fulfillmentStatus": "FULFILLED",
      "odooSaleOrderId": 701,
      "downloadedAt": "2026-10-01T09:15:00Z"
    }
  ]
}
```

### `GET /api/v1/orders/:id`

Returns the full order:

```json
{
  "head": { "…": "the order head, amounts as decimal strings" },
  "lines": [
    {
      "lineNo": 1,
      "sku": "TSHIRT-CLASSIC",
      "quantity": 2,
      "listPrice": "25.00",
      "discountTotal": "5.00",
      "taxTotal": "4.50",
      "netPrice": "22.50",
      "lineSubtotal": "50.00",
      "netTotal": "45.00",
      "lineTotal": "49.50",
      "discountCodes": ["SAVE10"],
      "taxLines": [{ "title": "GST", "percentage": 10, "amount": "4.50", "odooTaxId": 5 }]
    }
  ],
  "discounts": [
    {
      "code": "SAVE10",
      "title": "SAVE10",
      "allocationMethod": "ACROSS",
      "targetType": "LINE_ITEM",
      "valueType": "percentage",
      "valuePercentage": 10,
      "amount": "8.00",
      "scope": "line"
    }
  ],
  "lineDiscounts": [{ "lineNo": 1, "code": "SAVE10", "amount": "5.00" }],
  "transactions": [
    { "kind": "capture", "status": "success", "gateway": "shopify_payments", "amount": "79.20" }
  ],
  "fulfillments": [{ "sourceFulfillmentId": "…", "status": "SUCCESS", "trackingNumbers": ["TRACK-123"] }],
  "validations": [{ "ruleCode": "VAL-001", "severity": "blocking", "passed": true, "message": "…" }],
  "pickings": [{ "name": "WH/OUT/00042", "state": "confirmed" }],
  "publishAttempts": [{ "method": "xmlrpc", "status": "success", "odooSaleOrderId": 701 }],
  "artifacts": [{ "kind": "sale-order-xml", "filename": "shopify-1001-sale-order.xml", "checksum": "…" }]
}
```

### `POST /api/v1/orders/ingest`

Downloads the orders from Shopify.  Body (all optional):

```json
{ "query": "updated_at:>=2026-10-01 status:any", "limit": 200 }
```

```json
{
  "received": 2,
  "created": 2,
  "updated": 0,
  "failed": 0,
  "orderIds": ["1001", "1002"],
  "errors": []
}
```

`207 Multi-Status` is returned when some orders failed.

### `POST /api/v1/orders/:id/validate`

Runs the rule set and stores the result.

```json
{
  "headId": "6b1c…",
  "status": "passed",
  "results": [{ "ruleCode": "VAL-001", "severity": "blocking", "passed": true, "message": "…" }],
  "blockingFailures": [],
  "warnings": [],
  "passedRules": 13,
  "totalRules": 13
}
```

`422` is returned when a blocking rule fails.

### `POST /api/v1/orders/:id/approve`

```json
{ "decision": "approve", "comment": "checked against the picking list" }
```

`decision` is `approve` (default) or `reject`; a rejection needs a `reason`.
The order must have passed the validation first.

### `POST /api/v1/orders/:id/publish`

```json
{ "method": "xmlrpc", "force": false, "comment": "nightly run" }
```

`method` is `xmlrpc` (default), `jsonrpc` or `dmf`.

```json
{
  "status": "published",
  "headId": "6b1c…",
  "method": "xmlrpc",
  "odooSaleOrderId": 701,
  "partnerId": 55,
  "warnings": [],
  "pickings": [{ "name": "WH/OUT/00042", "state": "confirmed" }]
}
```

`status` is `published`, `artifact_ready` (DMF), `skipped` (already published)
or `failed`.  `422` is returned for a failure.

### `GET /api/v1/orders/:id/dmf` and `GET /api/v1/orders/:id/dmf/:artifactId`

The first lists the generated artefacts, the second downloads one of them
(`text/csv`, `text/xml` or `application/json`).

### `GET /api/v1/orders/:id/audit`

The audit entries of one order.

## Settings, mappings, audit and users

| Method | Path | Body / notes |
|---|---|---|
| `GET` | `/api/v1/settings` | the effective settings and the stored overrides |
| `PUT` | `/api/v1/settings` | `approvalThresholdAmount`, `supportedCurrencies`, `companyId`, `warehouseId`, `pricelistId`, `paymentTermId`, `currencyId`, `fallbackOdooProductId`, `fallbackOdooTaxId`, `confirmSaleOrder`, `writeCustomFields`, `dmfUploadEnabled`, … |
| `GET` | `/api/v1/mappings/products` | the Shopify → Odoo product mappings |
| `POST` | `/api/v1/mappings/products` | `{ "sku": "TSHIRT-CLASSIC", "odooProductId": 101, "shopifyVariantId": "gid://shopify/ProductVariant/501" }` |
| `DELETE` | `/api/v1/mappings/products/:id` | |
| `GET` | `/api/v1/mappings/taxes` | the Shopify → Odoo tax mappings |
| `POST` | `/api/v1/mappings/taxes` | `{ "shopifyTaxTitle": "GST", "odooTaxId": 5, "shopifyPercentage": 10 }` |
| `DELETE` | `/api/v1/mappings/taxes/:id` | |
| `GET` | `/api/v1/audit` | `action`, `entityId`, `limit`, `offset` |
| `GET` | `/api/v1/users` | the application users (no key is ever returned) |
| `POST` | `/api/v1/users` | `{ "name": "…", "role": "operator", "apiKey": "…" }` |

## Errors

```json
{ "error": "invalid_request", "message": "The request payload is not valid", "issues": [{ "path": "limit", "message": "…" }] }
```

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | the body or the query is not valid |
| 401 | `unauthorized` | the API key is missing or unknown (the payload carries a `hint`) |
| 403 | `forbidden` | the role is not allowed to perform the action |
| 404 | `not_found` | the route does not exist, or the order does not exist |
| 409 | `not_configured` | Shopify or Odoo is not configured |
| 422 | — | the validation or the approval gate blocked the operation |
| 500 | `internal_error` | an unexpected error (the details are in the logs) |

The `401` payload explains how to authenticate:

```json
{
  "error": "unauthorized",
  "message": "An API key is required (X-API-Key header)",
  "hint": "Send the API key in the \"X-API-Key\" header (or \"Authorization: Bearer <key>\"). The public endpoints are /, /health, /ready and /docs."
}
```

An unknown route answers `404` with
`{"error": "not_found", "message": "The route GET /nope does not exist"}` —
never `401`, so a typo is not mistaken for an authentication problem.
