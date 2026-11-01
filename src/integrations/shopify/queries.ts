/**
 * GraphQL documents for the Shopify Admin API (2026-07 and newer).
 *
 * The feed deliberately requests the *allocation* level discount data:
 * `discountApplications` describes the intent of a discount, while
 * `discountAllocations` carries the money that was actually deducted from a
 * line.  Both are needed to rebuild the sales order lines exactly.
 */

export const ORDER_FIELDS = `
  id
  legacyResourceId
  name
  number
  email
  phone
  poNumber
  createdAt
  updatedAt
  processedAt
  currencyCode
  presentmentCurrencyCode
  sourceName
  sourceIdentifier
  displayFinancialStatus
  displayFulfillmentStatus
  paymentGatewayNames
  note
  tags
  test
  currentSubtotalPriceSet { shopMoney { amount currencyCode } }
  currentTotalTaxSet { shopMoney { amount currencyCode } }
  currentTotalDiscountsSet { shopMoney { amount currencyCode } }
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount currencyCode } }
  totalReceivedSet { shopMoney { amount currencyCode } }
  totalRefundedSet { shopMoney { amount currencyCode } }
  totalOutstandingSet { shopMoney { amount currencyCode } }
  currentTaxLines { title taxable percentage priceSet { shopMoney { amount currencyCode } } }
  taxLines { title taxable percentage priceSet { shopMoney { amount currencyCode } } }
  customer {
    id
    legacyResourceId
    email
    firstName
    lastName
    phone
    numberOfOrders
  }
  billingAddress {
    name
    firstName
    lastName
    company
    address1
    address2
    city
    province
    provinceCode
    zip
    country
    countryCodeV2
    phone
  }
  shippingAddress {
    name
    firstName
    lastName
    company
    address1
    address2
    city
    province
    provinceCode
    zip
    country
    countryCodeV2
    phone
  }
  discountApplications(first: 50) {
    nodes {
      __typename
      index
      allocationMethod
      targetSelection
      targetType
      value {
        __typename
        ... on MoneyV2 { amount currencyCode }
        ... on PricingPercentageValue { percentage }
      }
      ... on DiscountCodeApplication { code }
      ... on ManualDiscountApplication { title }
    }
  }
  shippingLines(first: 25) {
    nodes {
      title
      carrierIdentifier
      originalPriceSet { shopMoney { amount currencyCode } }
      discountedPriceSet { shopMoney { amount currencyCode } }
      taxLines { title taxable percentage priceSet { shopMoney { amount currencyCode } } }
      discountAllocations {
        allocatedAmountSet { shopMoney { amount currencyCode } }
        discountApplication {
          index
          allocationMethod
          targetType
          value {
            __typename
            ... on MoneyV2 { amount currencyCode }
            ... on PricingPercentageValue { percentage }
          }
          ... on DiscountCodeApplication { code }
        }
      }
    }
  }
  lineItems(first: 250) {
    nodes {
      id
      name
      title
      sku
      variantTitle
      quantity
      currentQuantity
      product { id legacyResourceId title productType vendor }
      variant { id legacyResourceId sku title }
      originalUnitPriceSet { shopMoney { amount currencyCode } }
      originalTotalSet { shopMoney { amount currencyCode } }
      discountedTotalSet { shopMoney { amount currencyCode } }
      totalDiscountSet { shopMoney { amount currencyCode } }
      priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }
      taxLines { title taxable percentage priceSet { shopMoney { amount currencyCode } } }
      discountAllocations {
        allocatedAmountSet { shopMoney { amount currencyCode } }
        discountApplication {
          index
          allocationMethod
          targetType
          value {
            __typename
            ... on MoneyV2 { amount currencyCode }
            ... on PricingPercentageValue { percentage }
          }
          ... on DiscountCodeApplication { code }
        }
      }
    }
  }
  transactions(first: 100) {
    id
    kind
    status
    gateway
    processedAt
    errorMessage
    receiptJson
    test
    amountSet { shopMoney { amount currencyCode } }
    parentTransaction { id }
  }
  fulfillments(first: 25) {
    id
    status
    createdAt
    updatedAt
    trackingInfo { number url }
    fulfillmentLineItems { quantity lineItem { id } }
  }
`;

export const ORDERS_QUERY = `
query CentralOrderFeed($cursor: String, $pageSize: Int!, $query: String) {
  orders(first: $pageSize, after: $cursor, sortKey: UPDATED_AT, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {${ORDER_FIELDS}}
  }
}
`;

export const ORDER_BY_ID_QUERY = `
query CentralOrderById($id: ID!) {
  order(id: $id) {${ORDER_FIELDS}}
}
`;
