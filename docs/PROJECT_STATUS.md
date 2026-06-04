# AI Development Notes

Business Rules

- Value In = acquisition cost
- Estimated Sold = expected future sale value
- Potential Reward = Estimated Sold - Value In
- Realized Gain = Value Out - Value In

Operations

- Cash flow balances must never be updated manually.
- Always use recalculateCashFlowBalancesFrom().
- Deal edits affecting cash must trigger balance recalculation.

Inventory

- owned/listed => show Potential Reward
- sold/traded => show Realized Gain

Development Rules

- Read architecture.md first
- Read database-schema.md before DB changes
- Read PROJECT_STATUS.md before implementing features
- Explain implementation plan before modifying files

# Project Status

Last Updated: 2026-06-02

## Overview

The Guitar Tracker application is a private inventory and transaction management system used to track guitars, amps, pedals, and related gear.

The application is intended for:

* Roman
* Brother

The project serves two purposes:

1. Manage real inventory and business operations
2. Learn AI-assisted software development practices

---

# Current Environment Setup

## Source Control

GitHub repository configured.

Branches:

* main → Production
* dev → Development

Workflow:

* Development work happens in dev
* Vercel Preview deployments use dev
* Production deployments use main

---

## Hosting

### Frontend

* Vercel

### Database

* Supabase
* PostgreSQL

---

## Environments

### Development

Local development environment.

Can point to a separate Supabase database.

### Preview

Vercel preview deployment.

Connected to development Supabase database.

Used for testing before production deployment.

### Production

Vercel production deployment.

Connected to production Supabase database.

---

# Database Status

## Production Database

New clean production database created.

Schema is managed through Supabase migrations.

Migration files are stored in source control.

Example:

```text
supabase/migrations/
```

---

## Migration Workflow

Schema changes should be:

1. Created locally
2. Stored as migrations
3. Committed to Git
4. Applied to production through Supabase

Avoid manual schema changes whenever possible.

---

# Implemented Features

## Authentication

Implemented using Supabase Auth.

Users can:

* Login
* Access protected application pages

Current users:

* Roman
* Brother

---

## Inventory Management

Implemented.

Users can:

* Create inventory items
* View inventory items
* Edit inventory items

Tracked information:

* Brand
* Model
* Type
* Condition
* Collection Type
* Estimated Value
* Notes
* Year
* Color

Status values:

* owned
* sold
* traded

---

## Buy Operation

Implemented.

Creates:

* Deal
* Deal Item
* Cash Flow Entry

Updates:

* Inventory ownership status

---

## Sell Operation

Implemented.

Creates:

* Deal
* Deal Item
* Cash Flow Entry

Updates:

* Inventory item status to sold
* Sold date

---

## Trade Operation

Implemented.

Supports:

* 1-for-1 trades
* Multiple outgoing items
* Multiple incoming items
* Cash in
* Cash out

Creates:

* Deal
* Deal Items
* Cash Flow Entry (when cash is involved)

Updates:

* Outgoing items → traded
* Incoming items → owned

---

## Expense Operation

Implemented.

Creates:

* Cash Flow Entry

Supports:

* Historical dates
* Notes
* Expense tracking

---

# Cash Flow System

## Current Design

Cash flow tracks:

* Opening Balance
* Cash In
* Cash Out
* Closing Balance

Formula:

Closing Balance = Opening Balance - Cash Out + Cash In

---

## Historical Data Support

Historical transactions may be entered after newer transactions already exist.

Example:

* Existing transaction: 2026-06-01
* User inserts expense: 2026-05-20

This requires recalculation of future balances.

---

## Cash Flow Recalculation

Implemented.

Database function:

```text
recalculate_cash_flow_balances_from()
```

Behavior:

* Recalculates only transactions after the inserted cash flow row
* Does not recalculate the entire table
* Preserves historical baseline balances

This prevents corruption of previously validated historical balances.

---

## Historical Import

Historical cash flow data imported from Excel.

Rules used:

* Historical records assigned sequential placeholder dates
* Existing Excel balances preserved
* Balance sign convention inverted to match application design

Current historical dataset:

* 171 imported rows

---

# Dashboard

Implemented.

Current metrics:

* Cash Received
* Monthly Profit
* Expenses
* Net Profit

Additional metrics planned later.

---

# Current Known Limitations

## Transactions Not Yet Atomic

Buy, Sell, Trade, and Expense operations currently perform multiple database operations.

Future improvement:

Move business operations into PostgreSQL RPC functions.

Benefits:

* Atomic transactions
* Better data consistency
* Simpler frontend logic

---

## No Edit/Delete Recalculation Yet

Cash flow recalculation currently occurs on inserts.

Future support needed for:

* Edit cash flow
* Delete cash flow

---

# Upcoming Priorities

## Priority 1

Historical Deal Import

Goal:

Import approximately 37 historical transactions using application UI.

Benefits:

* Validates workflows
* Builds production dataset
* Identifies edge cases

---

## Priority 2

Inventory Verification

Validate:

* Item statuses
* Deal relationships
* Cash flow balances

---

## Priority 3

Dashboard Improvements

Potential additions:

* Realized Profit
* Unrealized Profit
* Inventory Equity
* Inventory Value
* Monthly Deal Count

---

## Priority 4

Photo Storage

Potential implementation:

* Supabase Storage

Features:

* Item photos
* Multiple photos per item

---

## Priority 5

Analytics

Future metrics:

* ROI by brand
* ROI by platform
* Hold time
* Cash velocity
* Liquidity score
* Monthly profitability

---

# Long-Term Vision

The application should evolve into a complete gear trading management system.

Goals:

* Inventory tracking
* Deal tracking
* Cash flow management
* Profitability analysis
* Business intelligence
* Multi-user support

The project should remain practical, simple, and focused on supporting real-world guitar trading operations.
