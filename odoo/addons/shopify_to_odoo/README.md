# Shopify to Odoo Bridge (Odoo 19 addon)

This addon adds the Shopify provenance to the Odoo sales order so that an
order imported by the central order management service can be reconciled with
the shop order it came from.

## What it adds

| Model | Field | Purpose |
|---|---|---|
| `sale.order` | `x_shopify_order_id` | Technical Shopify order id (unique) |
| `sale.order` | `x_shopify_order_number` | Shopify order name, e.g. `#1001` |
| `sale.order` | `x_shopify_source` | Source system (`shopify`) |
| `sale.order` | `x_shopify_currency` | Shop currency of the order |
| `sale.order` | `x_shopify_total` | Total as downloaded from Shopify |
| `res.partner` | `x_shopify_customer_id` | Technical Shopify customer id |

## Installation

1. Copy the `shopify_to_odoo` folder into your Odoo addons path
   (for example `/odoo/addons/`).
2. Restart Odoo and install **Settings > Apps > Technical > Apps** ->
   *Shopify to Odoo Bridge*.
3. The module only depends on `sale`, so it also works on the Odoo Online free
   plan where the Sales application is available.

The addon is **optional**: when it is not installed, the integration service
retries the sales order creation without the `x_shopify_*` fields, so the
orders are still created (the trade-off is that the Odoo document cannot be
traced back to Shopify).

## Reverse engineering note

The central order management service publishes the orders with the external
API (XML-RPC or JSON-RPC).  It writes the fields above when they exist; the
unique constraint on `x_shopify_order_id` protects the database against a
double import even if the service is run twice.
