# Database Schema

## Overview

This application tracks:

* Inventory items
* Buy/sell/trade operations
* Expenses
* Cash flow
* Brand normalization
* Dashboard metrics
* Future analytics and liquidity metrics

The schema is designed around:

* normalized inventory
* transaction-based operations
* flexible trade support
* separate cash-flow tracking
* historical data support
* future analytics expansion

---

# Tables

## brands

Normalized list of brands.

Examples:

* Fender
* Gibson
* PRS
* ESP
* Ibanez

Used for:

* analytics
* filtering
* search
* reporting

### Columns

| Column     | Type        | Notes                     |
| ---------- | ----------- | ------------------------- |
| id         | int8        | Primary key               |
| name       | text        | Unique brand name         |
| created_at | timestamptz | Record creation timestamp |

### Relationships

* One brand can have many inventory_items

---

## inventory_items

Represents a physical inventory item.

Examples:

* Guitar
* Amp
* Cab
* Pedal
* Pickups

This table stores item-specific information only.

Transaction information belongs to:

* deals
* deal_items
* cash_flow
* inventory_expenses

### Columns

| Column               | Type        | Notes                                      |
| -------------------- | ----------- | ------------------------------------------ |
| id                   | int8        | Primary key                                |
| brand_id             | int8        | FK → brands.id                             |
| item_type            | text        | guitar / amp / cab / pedal / pickups       |
| model                | text        | Item model                                 |
| date_listed          | date        | Optional listing date                      |
| sold_date            | date        | Optional sold/traded date                  |
| estimated_sold_value | numeric     | Estimated market value                     |
| collection_type      | text        | Personal / Hybrid / Business               |
| condition            | text        | Mint / Excellent / Very Good / Good / Fair |
| status               | text        | owned / listed / sold / traded             |
| notes                | text        | Optional notes                             |
| created_at           | timestamptz | Record creation timestamp                  |
| updated_at           | timestamptz | Last update timestamp                      |
| year                 | int4        | Optional manufacturing year                |
| color                | text        | Optional color/finish                      |

### Relationships

* Many inventory_items belong to one brand
* One inventory_item can participate in many deal_items
* One inventory_item can have many inventory_expenses

---

## deals

Represents a business transaction.

Examples:

* Purchase
* Sale
* Trade
* Expense

This is the source of truth for:

* transaction date
* acquisition/sale/trade channel
* transaction type
* cash movement summary

### Columns

| Column        | Type        | Notes                                               |
| ------------- | ----------- | --------------------------------------------------- |
| id            | int8        | Primary key                                         |
| deal_date     | date        | Transaction date                                    |
| deal_type     | text        | purchase / sale / trade / expense                   |
| channel       | text        | Marketplace / Kijiji / Reverb / Regular Buyer / etc |
| cash_received | numeric     | Money received                                      |
| cash_paid     | numeric     | Money paid                                          |
| fees          | numeric     | Fees if applicable                                  |
| notes         | text        | Optional transaction notes                          |
| created_at    | timestamptz | Record creation timestamp                           |

### Relationships

* One deal can have many deal_items
* One deal can have many cash_flow records
* One deal can have one or more inventory_expenses

---

## deal_items

Represents item movement inside a deal.

This table allows:

* 1-for-1 trades
* 2-for-1 trades
* 1-for-2 trades
* trade + cash deals
* bundle transactions
* purchase item entry
* sale item exit

### Columns

| Column      | Type        | Notes                         |
| ----------- | ----------- | ----------------------------- |
| id          | int8        | Primary key                   |
| deal_id     | int8        | FK → deals.id                 |
| item_id     | int8        | FK → inventory_items.id       |
| direction   | text        | in / out                      |
| cash_value  | numeric     | Cash portion assigned to item |
| trade_value | numeric     | Trade valuation               |
| total_value | numeric     | Combined total value          |
| notes       | text        | Optional notes                |
| created_at  | timestamptz | Record creation timestamp     |

### Relationships

* Many deal_items belong to one deal
* Many deal_items belong to one inventory_item

---

## inventory_expenses

Represents expenses related to inventory or business cash usage.

Examples:

* amp repair
* tubes
* guitar setup
* parts
* owner withdrawal
* general business expense

The item link is optional.

If item_id is null, the expense is general business cash movement or withdrawal.

### Columns

| Column       | Type        | Notes                            |
| ------------ | ----------- | -------------------------------- |
| id           | int8        | Primary key                      |
| deal_id      | int8        | Optional FK → deals.id           |
| item_id      | int8        | Optional FK → inventory_items.id |
| expense_date | date        | Expense date                     |
| amount       | numeric     | Expense amount                   |
| notes        | text        | Required description             |
| created_at   | timestamptz | Record creation timestamp        |

### Relationships

* One inventory_expense can belong to one deal
* One inventory_expense can belong to one inventory item
* Expenses affect cash_flow through their related deal

### Design Notes

Expenses are not stored directly on inventory_items.

Item cost basis should be calculated later as:

```text
value_in + sum(item-linked expenses)
```

This preserves expense history and allows future reporting.

---

## cash_flow

Tracks actual cash movement.

This table is separate from inventory movement.

Examples:

* purchase payment
* sale payout
* trade cash adjustment
* repair expense
* owner withdrawal
* manual cash adjustment

### Columns

| Column           | Type        | Notes                      |
| ---------------- | ----------- | -------------------------- |
| id               | int8        | Primary key                |
| deal_id          | int8        | Optional FK → deals.id     |
| transaction_date | date        | Cash movement date         |
| opening_balance  | numeric     | Previous balance           |
| cash_in          | numeric     | Incoming cash              |
| cash_out         | numeric     | Outgoing cash              |
| closing_balance  | numeric     | Calculated balance         |
| description      | text        | Human-readable description |
| created_at       | timestamptz | Record creation timestamp  |

### Balance Logic

Application convention:

```text
closing_balance =
opening_balance
- cash_out
+ cash_in
```

Positive balance means available business cash.

Negative balance means business debt / cash owed back.

### Historical Data Notes

Historical cash flow was imported from Excel.

Rules used:

* Excel row order was preserved
* Rows without dates received artificial sequential dates starting from 2020-01-01
* Opening and closing balances were sign-reversed to match app convention
* cash_in and cash_out were preserved as-is

---

# Views

## inventory_items_with_value

Used to show inventory items together with their acquisition value.

Purpose:

* avoid duplicating value_in on inventory_items
* calculate value_in from deal_items
* support dashboard inventory cost basis

Typical logic:

```text
inventory_items
+
deal_items where direction = 'in'
```

### Used By

* Inventory page
* Dashboard
* Cost basis calculations

---

## inventory_items_search

Used for consistent inventory search.

Joins:

* inventory_items
* brands

Adds:

* brand_name

Purpose:

* search by brand
* search by model
* search by color
* display brand + model in operation search results

### Important Note

Objects returned from this view may include `brand_name`.

Do not spread search result objects into inventory_items updates.

Correct update pattern:

```ts
updateInventoryItem(item.id, {
  id: item.id,
  status: 'sold',
  sold_date: dealDate,
})
```

Avoid:

```ts
updateInventoryItem(item.id, {
  ...item,
  status: 'sold',
})
```

because `brand_name` does not exist on inventory_items.

---

# Database Functions

## recalculate_cash_flow_balances_from

Recalculates cash flow balances from a specific inserted cash_flow row forward.

Purpose:

* support historical transaction inserts
* prevent later balances from becoming incorrect
* avoid recalculating the entire table
* preserve validated historical baseline rows

### Behavior

Input:

```text
p_start_id
```

Process:

1. Find the inserted cash_flow row
2. Find the previous cash_flow row by transaction_date and id
3. Use previous closing_balance as starting point
4. Recalculate only rows from p_start_id forward
5. Leave all earlier rows unchanged

### Why This Exists

If a user inserts a past transaction after newer transactions already exist, all later opening/closing balances need to shift.

Example:

Existing:

```text
2026-05-20 sale
2026-05-27 trade cash adjustment
2026-06-02 sale
```

Insert later:

```text
2026-05-20 expense
```

The function recalculates:

```text
2026-05-20 expense
2026-05-27 trade cash adjustment
2026-06-02 sale
```

but does not touch earlier rows.

---

# Source of Truth Rules

* Item details belong to inventory_items
* Brand names belong to brands
* Acquisition/sale/trade date belongs to deals.deal_date
* Acquisition/sale channel belongs to deals.channel
* Cash movement belongs to cash_flow
* Trade structure belongs to deals + deal_items
* Item-linked expenses belong to inventory_expenses
* Profit and ROI should be calculated in reports, not manually stored everywhere

---

# Current Operation Flows

## Buy

Creates:

* inventory_items
* deals
* deal_items
* cash_flow

Then recalculates cash flow from inserted cash_flow row forward.

---

## Sell

Creates:

* deals
* deal_items
* cash_flow

Updates:

* inventory_items.status = sold
* inventory_items.sold_date = deal date

Then recalculates cash flow from inserted cash_flow row forward.

---

## Trade

Creates:

* deals
* deal_items
* cash_flow when cash in/out exists

Updates:

* outgoing items → traded
* incoming items → owned

Then recalculates cash flow from inserted cash_flow row forward when cash flow exists.

---

## Expense

Creates:

* deals with deal_type = expense
* inventory_expenses
* cash_flow

Optional:

* item_id may be null

Then recalculates cash flow from inserted cash_flow row forward.

---

# Dashboard Metrics

Current dashboard supports:

* Cash Balance
* Active Inventory
* Cost Basis
* Inventory Equity
* Monthly Cash Received
* Monthly Profit
* Monthly Expenses
* Monthly Net Profit

---

# Production / Development Environment

## Supabase

There are separate Supabase projects:

* development database
* production database

## Vercel

Environment setup:

* Preview deployments use development Supabase variables
* Production deployment uses production Supabase variables

Branches:

* dev → Preview
* main → Production

---

# Current Known Limitations

## Operations Are Not Yet Atomic

Buy, Sell, Trade, and Expense operations currently perform multiple frontend-driven database calls.

Future improvement:

Move operations into PostgreSQL RPC functions so related inserts/updates happen atomically.

Example:

```text
create deal
create deal_items
create cash_flow
update inventory status
recalculate cash flow
```

should eventually happen inside one database transaction.

---

## Cash Flow Recalculation Handles Inserts Only

Current recalculation is called after inserts.

Future support needed for:

* editing cash_flow rows
* deleting cash_flow rows
* editing deals
* deleting deals

---

## Historical Data Import Is Manual

Historical records are being entered through the UI to validate workflows.

This is intentional for the current phase.

Later, CSV import may be considered if the data volume grows.

---

# Future Improvements

## Transactions

Move buy/sell/trade/expense operations into PostgreSQL RPC functions.

Benefits:

* atomic operations
* rollback on failure
* simpler frontend logic
* fewer partial-save bugs

---

## Analytics

Future analytics may include:

* ROI by brand
* ROI by platform
* average hold time
* monthly profit
* cash velocity
* best-performing brands
* liquidity score
* expenses by item
* inventory equity

---

## Liquidity

Liquidity may eventually be calculated using:

* time on market
* sold frequency
* number of offers/messages
* cash vs trade demand
* platform performance
* average days to sell

---

## Multi-User Support

Planned:

* Roman inventory
* Brother inventory
* admin view for all records
* user_id separation
* stricter RLS policies

---

# Development Principles

* Keep Phase 1 simple
* Do not overengineer too early
* Prefer clear schema over clever code
* Keep item data separate from transaction data
* Keep cash flow separate from inventory movement
* Use normalized brands for analytics
* Use views for reporting/search convenience
* Use small scoped Copilot prompts
* Add documentation before large feature changes
* Avoid refactoring unrelated code during feature work
* Do not spread search-view objects into table updates
* Validate dashboard numbers against Excel before trusting reports
