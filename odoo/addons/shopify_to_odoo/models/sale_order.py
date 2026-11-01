# -*- coding: utf-8 -*-
"""Provenance of the sales orders that were imported from Shopify.

The central order management service writes the Shopify identifiers onto the
sales order so that an operator can always trace an Odoo document back to the
shop order it came from, and so that the integration can be re-run safely
(the identifier is unique).
"""
from odoo import api, fields, models
from odoo.exceptions import ValidationError


class SaleOrder(models.Model):
    _inherit = "sale.order"

    x_shopify_order_id = fields.Char(
        string="Shopify Order Id",
        index=True,
        copy=False,
        help="Technical identifier of the order in the Shopify shop.",
    )
    x_shopify_order_number = fields.Char(
        string="Shopify Order Name",
        copy=False,
        help="Human readable order name, for example #1001.",
    )
    x_shopify_source = fields.Char(
        string="Shopify Source",
        copy=False,
        default="shopify",
    )
    x_shopify_currency = fields.Char(
        string="Shopify Currency",
        copy=False,
    )
    x_shopify_total = fields.Float(
        string="Shopify Total",
        digits="Product Price",
        copy=False,
        help="Total of the order in the shop currency, as downloaded from Shopify.",
    )
    x_shopify_customer_id = fields.Char(
        string="Shopify Customer Id",
        copy=False,
        index=True,
    )

    _sql_constraints = [
        (
            "sale_order_x_shopify_order_id_unique",
            "unique(x_shopify_order_id)",
            "A sales order for this Shopify order already exists.",
        ),
    ]

    @api.constrains("x_shopify_order_id", "partner_id")
    def _check_shopify_order_id(self):
        for order in self:
            if not order.x_shopify_order_id:
                continue
            duplicate = self.search_count(
                [
                    ("id", "!=", order.id),
                    ("x_shopify_order_id", "=", order.x_shopify_order_id),
                ]
            )
            if duplicate:
                raise ValidationError(
                    "The Shopify order %s is already imported as another sales order."
                    % order.x_shopify_order_id
                )

    def action_view_shopify_reference(self):
        """Open the order in the shop (handy for an operator)."""
        self.ensure_one()
        if not self.x_shopify_order_id:
            return False
        return {
            "type": "ir.actions.act_url",
            "url": "https://admin.shopify.com/orders/%s" % self.x_shopify_order_id,
            "target": "new",
        }


class ResPartner(models.Model):
    _inherit = "res.partner"

    x_shopify_customer_id = fields.Char(
        string="Shopify Customer Id",
        copy=False,
        index=True,
        help="Technical identifier of the customer in the Shopify shop.",
    )
