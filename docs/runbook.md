# Runbook

## 1. Daily operation

```bash
# 1. Download the new orders
curl -s -X POST http://localhost:8080/api/v1/orders/ingest \
  -H "X-API-Key: $OPERATOR_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query": "updated_at:>=2026-10-01 status:any"}'

# 2. Look at what is waiting
curl -s "http://localhost:8080/api/v1/orders?validationStatus=pending" \
  -H "X-API-Key: $OPERATOR_API_KEY"

# 3. Validate and publish (the threshold decides whether an approval is needed)
curl -s -X POST http://localhost:8080/api/v1/orders/$ID/validate -H "X-API-Key: $OPERATOR_API_KEY"
curl -s -X POST http://localhost:8080/api/v1/orders/$ID/publish  -H "X-API-Key: $OPERATOR_API_KEY" \
  -H 'Content-Type: application/json' -d '{"method": "xmlrpc"}'
```

The same flow is available as one command:

```bash
npm run sync -- --query "updated_at:>=2026-10-01 status:any" --publish xmlrpc
```

`npm run sync` exits with `2` when some orders did not pass the validation.

## 2. The approval workflow

* Orders **below** `approvalThresholdAmount` are auto approved once they pass
  the validation.
* Orders **at or above** the threshold need an explicit approval:

```bash
curl -s -X POST http://localhost:8080/api/v1/orders/$ID/approve \
  -H "X-API-Key: $APPROVER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"decision": "approve", "comment": "checked against the picking list"}'
```

The threshold is changed at runtime (no restart):

```bash
curl -s -X PUT http://localhost:8080/api/v1/settings \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"approvalThresholdAmount": 250}'
```

## 3. Frequent situations

| Symptom | Diagnosis | Action |
|---|---|---|
| `422` on publish, `Validation failed: VAL-008` | a line has no Odoo product | create the mapping: `POST /api/v1/mappings/products` with the SKU and the Odoo product id |
| `422` on publish, `Validation failed: VAL-009` | a tax has no Odoo tax | `POST /api/v1/mappings/taxes` with the Shopify tax title and the Odoo tax id |
| `422` on publish, `Validation failed: VAL-001` | the order does not reconcile | inspect `GET /api/v1/orders/$ID` → `lines` and `validations`; the raw payload is kept in `sales_order_head.raw` |
| `422` on publish, "waiting for approval" | the order is above the threshold | approve it or lower the threshold |
| `failed` with "No Odoo instance is configured" | `ODOO_URL` is not set | set the Odoo variables and restart |
| `failed` with an Odoo error | the Odoo call failed | read the `publish_attempt` row (request + response); the order can be re-published with `{"force": true}` |
| `skipped` on publish | the order was already published | check `odoo_sale_order_id`; use `force` only after a manual correction in Odoo |
| `artifact_ready` on publish | the DMF was generated but not uploaded | download the artefact from `GET /api/v1/orders/$ID/dmf` and import it in Odoo, or enable `dmfUploadEnabled` |

## 4. Replaying a failed publish

1. `GET /api/v1/orders/$ID` → `publishAttempts` shows the request, the response
   and the error.
2. Fix the cause (mapping, settings, Odoo side).
3. `POST /api/v1/orders/$ID/publish` with `{"force": true}`.

The publish is idempotent: when Odoo already has a sales order with the same
`client_order_ref`, the existing order is reused instead of creating a second
one.

## 5. Re-downloading an order

`POST /api/v1/orders/ingest` is idempotent: the head is updated in place and
the lines, the discounts and the transactions are replaced inside a single
transaction.  A re-download never creates a duplicate order — `VAL-010`
verifies it.

## 6. Backup, restore and recovery

* **Neon**: use the Neon branch/backup features (or `pg_dump` against the
  connection string) and restore with `psql`.  The schema is in
  `docs/schema.sql`, the migrations are in `src/db/migrations/`.
* **Embedded PGlite**: the data lives in `$PGLITE_PATH`; copy the directory
  while the service is stopped.
* **Replay**: the raw Shopify payload is kept in `sales_order_head.raw`, so an
  order can be rebuilt without calling Shopify again.

The recovery time and the recovery point objectives still have to be agreed
with the accountable owner (open decision `EV-F430EABE23`).

## 7. Monitoring

| Signal | Where |
|---|---|
| the service is up | `GET /health` returns `{"status": "ok"}` |
| the database is reachable | `GET /ready` |
| the orders are flowing | `GET /api/v1/orders?validationStatus=failed` |
| the publish is failing | `audit_log` where `action = 'order.publish'` and `result = 'failure'` |
| what is waiting for an approval | `GET /api/v1/orders?approvalStatus=pending` |

## 8. Security operations

* The API keys are stored hashed.  A lost key is replaced by seeding a new
  one (`npm run seed -- --admin-key <new key>`); the old key is deactivated
  with `UPDATE app_user SET active = false WHERE …`.
* Only the `admin` role can read the audit trail and change the settings.
* The customer data (name, email, phone, address) is stored in the central
  tables because Odoo needs it.  The retention period must be agreed with the
  data owner; the tables to purge are `sales_order_head.raw` (the raw payload)
  and the audit trail.
* Never put a credential into a `.env` file that is committed; `.env` is
  ignored by git.
