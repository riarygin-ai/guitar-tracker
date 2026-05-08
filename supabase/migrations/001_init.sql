-- Supabase migration: Initial schema for guitar inventory app

create table brands (
    id bigint generated always as identity primary key,
    name text not null unique,
    created_at timestamptz not null default now()
);

create table inventory_items (
    id bigint generated always as identity primary key,
    brand_id bigint not null references brands(id),
    item_type text not null default 'guitar',
    model text not null,
    date_acquired date,
    date_listed date,
    sold_date date,
    estimated_sold_value numeric(12,2),
    collection_type text,
    condition text,
    status text not null default 'owned',
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table deals (
    id bigint generated always as identity primary key,
    deal_date date not null,
    deal_type text not null,
    channel text,
    cash_received numeric(12,2) default 0,
    cash_paid numeric(12,2) default 0,
    fees numeric(12,2) default 0,
    notes text,
    created_at timestamptz not null default now()
);

create table deal_items (
    id bigint generated always as identity primary key,
    deal_id bigint not null references deals(id) on delete cascade,
    item_id bigint not null references inventory_items(id),
    direction text not null,
    cash_value numeric(12,2),
    trade_value numeric(12,2),
    total_value numeric(12,2),
    notes text,
    created_at timestamptz not null default now()
);
