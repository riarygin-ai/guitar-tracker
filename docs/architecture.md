# Architecture

## Project Goal

This app is a private gear tracking system for guitar-related inventory and deals.

Primary users:
- Roman
- Brother

Primary purpose:
- Track inventory
- Track buy/sell/trade operations
- Track cash flow
- Track profit and ROI later
- Practice AI-assisted development and project management

## Tech Stack

- Next.js
- TypeScript
- Tailwind CSS
- Supabase
- PostgreSQL
- GitHub
- VS Code / Copilot / ChatGPT

## Architecture Style

This is a small full-stack web app.

Frontend and backend logic live in the same Next.js project.

The app should stay simple and avoid overengineering in Phase 1.

## Core Domain Concepts

### inventory_items

Represents a physical item.

Examples:
- Guitar
- Amp
- Cab
- Pedal
- Pickups

This table stores item-specific information only.

Examples:
- item_type
- brand_id
- model
- year
- color
- condition
- estimated_sold_value
- collection_type
- notes

It should NOT store acquisition channel or acquisition date.

---

### brands

Represents normalized brand names.

Examples:
- Fender
- Gibson
- PRS
- ESP
- Ibanez

Brand names are normalized for analytics and reporting.

---

### deals

Represents a business transaction.

Examples:
- Buy
- Sell
- Trade

This table stores transaction-level information.

Examples:
- deal_type
- deal_date
- channel
- cash_paid
- cash_received
- fees
- notes

The deal date is the source of truth for acquisition/sale/trade date.

The channel is also stored here because channel belongs to the transaction, not the item.

---

### deal_items

Represents inventory movement inside a deal.

This supports:
- 1-for-1 trades
- 2-for-1 trades
- 1-for-2 trades
- cash purchases
- cash sales
- trade + cash scenarios

Examples:
- item goes in
- item goes out

Fields:
- deal_id
- item_id
- direction
- cash_value
- trade_value
- total_value

---

### cash_flow

Represents actual cash movement.

This is separate from inventory movement.

Examples:
- cash paid for purchase
- cash received from sale
- fees
- adjustments

Cash flow tracks:
- transaction_date
- opening_balance
- cash_in
- cash_out
- closing_balance
- description

Current calculation:

closing_balance = opening_balance - cash_out + cash_in

Opening balance comes from the previous cash_flow row closing_balance.

## Source of Truth Rules

- Item details belong to inventory_items
- Brand names belong to brands
- Acquisition date belongs to deals.deal_date
- Acquisition channel belongs to deals.channel
- Cash movement belongs to cash_flow
- Trade structure belongs to deals + deal_items
- Profit and ROI should be calculated later, not manually stored everywhere

## Current Phase

Phase 1 focuses on:

- Clean inventory model
- Create/edit inventory items
- Buy operation
- Cash flow tracking
- Basic UI
- Supabase integration

Out of scope for Phase 1:

- Authentication
- Photo upload
- Reverb integration
- Marketplace/Kijiji automation
- Advanced analytics
- Liquidity score
- Full transaction/RPC refactor

## Future Improvements

### Transactions

Buy/sell/trade operations should eventually be moved into PostgreSQL RPC functions so related inserts are atomic.

Example:

Buy operation should insert into:
- deals
- deal_items
- cash_flow

as one transaction.

### Analytics

Future analytics may include:

- ROI by brand
- ROI by platform
- average hold time
- monthly profit
- cash velocity
- best-performing brands
- liquidity score

### Liquidity

Liquidity may eventually be calculated using:

- time on market
- sold frequency
- number of offers/messages
- cash vs trade demand
- platform performance
- average days to sell

## Development Principles

- Keep Phase 1 simple
- Do not overengineer too early
- Prefer clear schema over clever code
- Keep item data separate from transaction data
- Use normalized brands for analytics
- Use small scoped Copilot prompts
- Add documentation before large feature changes
- Avoid refactoring unrelated code during feature work