# Database Schema

## Overview

This application tracks:
- Inventory items
- Buy/sell/trade operations
- Cash flow
- Brand normalization
- Future analytics and liquidity metrics

The schema is designed around:
- normalized inventory
- transaction-based operations
- flexible trade support
- future analytics expansion

---

# Tables

## brands

Normalized list of brands.

Examples:
- Fender
- Gibson
- PRS
- ESP
- Ibanez

Used for:
- analytics
- filtering
- search
- reporting

### Columns

| Column | Type | Notes |
|---|---|---|
| id | int8 | Primary key |
| name | text | Unique brand name |
| created_at | timestamptz | Record creation timestamp |

### Relationships

- One brand can have many inventory_items

---

## inventory_items

Represents a physical inventory item.

Examples:
- Guitar
- Amp
- Cab
- Pedal
- Pickups

This table stores item-specific information only.

Transaction information belongs to:
- deals
- deal_items
- cash_flow

### Columns

| Column | Type | Notes |
|---|---|---|
| id | int8 | Primary key |
| brand_id | int8 | FK → brands.id |
| item_type | text | guitar / amp / cab / pedal / pickups |
| model | text | Item model |
| date_listed | date | Optional listing date |
| sold_date | date | Optional sold/traded date |
| estimated_sold_value | numeric | Estimated market value |
| collection_type | text | Personal / Hybrid / Business |
| condition | text | Mint / Excellent / Very Good / Good / Fair |
| status | text | owned / listed / sold / traded |
| notes | text | Optional notes |
| created_at | timestamptz | Record creation timestamp |
| updated_at | timestamptz | Last update timestamp |
| year | int4 | Optional manufacturing year |
| color | text | Optional color/finish |

### Relationships

- Many inventory_items belong to one brand
- One inventory_item can participate in many deal_items

---

## deals

Represents a business transaction.

Examples:
- Purchase
- Sale
- Trade

This is the source of truth for:
- transaction date
- acquisition/sale channel
- cash movement summary

### Columns

| Column | Type | Notes |
|---|---|---|
| id | int8 | Primary key |
| deal_date | date | Transaction date |
| deal_type | text | purchase / sale / trade |
| channel | text | Marketplace / Kijiji / Reverb / etc |
| cash_received | numeric | Money received |
| cash_paid | numeric | Money paid |
| fees | numeric | Fees, shipping, repairs, etc |
| notes | text | Optional transaction notes |
| created_at | timestamptz | Record creation timestamp |

### Relationships

- One deal can have many deal_items
- One deal can have many cash_flow records

---

## deal_items

Represents item movement inside a deal.

This table allows:
- 1-for-1 trades
- 2-for-1 trades
- trade + cash deals
- bundle transactions

### Columns

| Column | Type | Notes |
|---|---|---|
| id | int8 | Primary key |
| deal_id | int8 | FK → deals.id |
| item_id | int8 | FK → inventory_items.id |
| direction | text | in / out |
| cash_value | numeric | Cash portion assigned to item |
| trade_value | numeric | Trade valuation |
| total_value | numeric | Combined total value |
| notes | text | Optional notes |
| created_at | timestamptz | Record creation timestamp |

### Relationships

- Many deal_items belong to one deal
- Many deal_items belong to one inventory_item

---

## cash_flow

Tracks actual cash movement.

This table is separate from inventory movement.

Examples:
- purchase payment
- sale payout
- shipping expense
- repair cost
- cash adjustment

### Columns

| Column | Type | Notes |
|---|---|---|
| id | int8 | Primary key |
| deal_id | int8 | Optional FK → deals.id |
| transaction_date | date | Cash movement date |
| opening_balance | numeric | Previous balance |
| cash_in | numeric | Incoming cash |
| cash_out | numeric | Outgoing cash |
| closing_balance | numeric | Calculated balance |
| description | text | Human-readable description |
| created_at | timestamptz | Record creation timestamp |

### Balance Logic

Current logic:

```text
closing_balance =
opening_balance
- cash_out
+ cash_in

