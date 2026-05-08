-- Create cash_flow table for standalone cash movement tracking
create table if not exists cash_flow (
  id bigint generated always as identity primary key,
  deal_id bigint references deals(id),
  transaction_date date not null,
  opening_balance numeric(12,2) not null default 0,
  cash_in numeric(12,2) not null default 0,
  cash_out numeric(12,2) not null default 0,
  closing_balance numeric(12,2) not null,
  description text,
  created_at timestamptz not null default now()
);

create or replace function cash_flow_before_insert() returns trigger language plpgsql as $$
begin
  if new.opening_balance is null then
    select closing_balance into new.opening_balance
    from cash_flow
    order by id desc
    limit 1;

    if new.opening_balance is null then
      new.opening_balance := 0;
    end if;
  end if;

  new.closing_balance := new.opening_balance - coalesce(new.cash_out, 0) + coalesce(new.cash_in, 0);
  return new;
end;
$$;

create trigger cash_flow_before_insert
before insert on cash_flow
for each row execute function cash_flow_before_insert();
