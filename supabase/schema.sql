drop extension if exists "pg_net";


  create table "public"."brands" (
    "id" bigint generated always as identity not null,
    "name" text not null,
    "created_at" timestamp with time zone not null default now()
      );



  create table "public"."cash_flow" (
    "id" bigint generated always as identity not null,
    "deal_id" bigint,
    "transaction_date" date not null,
    "opening_balance" numeric(12,2) not null default 0,
    "cash_in" numeric(12,2) not null default 0,
    "cash_out" numeric(12,2) not null default 0,
    "closing_balance" numeric(12,2) not null,
    "description" text,
    "created_at" timestamp with time zone not null default now()
      );



  create table "public"."deal_items" (
    "id" bigint generated always as identity not null,
    "deal_id" bigint not null,
    "item_id" bigint not null,
    "direction" text not null,
    "total_value" numeric(12,2),
    "notes" text,
    "created_at" timestamp with time zone not null default now()
      );



  create table "public"."deals" (
    "id" bigint generated always as identity not null,
    "deal_date" date not null,
    "deal_type" text not null,
    "channel" text,
    "cash_received" numeric(12,2) default 0,
    "cash_paid" numeric(12,2) default 0,
    "fees" numeric(12,2) default 0,
    "notes" text,
    "created_at" timestamp with time zone not null default now()
      );



  create table "public"."guitar_import_staging" (
    "Brand" text,
    "Model" text,
    "Date Acquired" text,
    "Estimated Sold Value" text,
    "In My Collection" text,
    "Condition" text,
    "Category" text,
    "Acquisition Channel" text,
    "Acquisition Type" text,
    "Value In" text,
    "Date of Listing" text,
    "Sold/Traded Date" text,
    "Sale Channel" text,
    "Sale Type" text,
    "Cash Value Out" text,
    "Trade Value Out" text,
    "Value Out" text,
    "Fees / AddsOn" text,
    "Notes" text,
    "Net Profit" text,
    "ROI %" text,
    "Estimation Accuracy %" text,
    "Time on Market" text,
    "Sold" text,
    "Month" text
      );



  create table "public"."inventory_expenses" (
    "id" bigint generated always as identity not null,
    "deal_id" bigint,
    "item_id" bigint,
    "expense_date" date not null,
    "amount" numeric(10,2) not null,
    "notes" text not null,
    "created_at" timestamp with time zone not null default now()
      );


alter table "public"."inventory_expenses" enable row level security;


  create table "public"."inventory_items" (
    "id" bigint generated always as identity not null,
    "brand_id" bigint not null,
    "item_type" text not null default 'guitar'::text,
    "model" text not null,
    "date_listed" date,
    "sold_date" date,
    "estimated_sold_value" numeric(12,2),
    "collection_type" text,
    "condition" text,
    "status" text not null default 'owned'::text,
    "notes" text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "year" integer,
    "color" text
      );


CREATE UNIQUE INDEX brands_name_key ON public.brands USING btree (name);

CREATE UNIQUE INDEX brands_pkey ON public.brands USING btree (id);

CREATE UNIQUE INDEX cash_flow_pkey ON public.cash_flow USING btree (id);

CREATE UNIQUE INDEX deal_items_pkey ON public.deal_items USING btree (id);

CREATE UNIQUE INDEX deals_pkey ON public.deals USING btree (id);

CREATE UNIQUE INDEX inventory_expenses_pkey ON public.inventory_expenses USING btree (id);

CREATE UNIQUE INDEX inventory_items_pkey ON public.inventory_items USING btree (id);

alter table "public"."brands" add constraint "brands_pkey" PRIMARY KEY using index "brands_pkey";

alter table "public"."cash_flow" add constraint "cash_flow_pkey" PRIMARY KEY using index "cash_flow_pkey";

alter table "public"."deal_items" add constraint "deal_items_pkey" PRIMARY KEY using index "deal_items_pkey";

alter table "public"."deals" add constraint "deals_pkey" PRIMARY KEY using index "deals_pkey";

alter table "public"."inventory_expenses" add constraint "inventory_expenses_pkey" PRIMARY KEY using index "inventory_expenses_pkey";

alter table "public"."inventory_items" add constraint "inventory_items_pkey" PRIMARY KEY using index "inventory_items_pkey";

alter table "public"."brands" add constraint "brands_name_key" UNIQUE using index "brands_name_key";

alter table "public"."cash_flow" add constraint "cash_flow_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES public.deals(id) not valid;

alter table "public"."cash_flow" validate constraint "cash_flow_deal_id_fkey";

alter table "public"."deal_items" add constraint "deal_items_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE not valid;

alter table "public"."deal_items" validate constraint "deal_items_deal_id_fkey";

alter table "public"."deal_items" add constraint "deal_items_item_id_fkey" FOREIGN KEY (item_id) REFERENCES public.inventory_items(id) not valid;

alter table "public"."deal_items" validate constraint "deal_items_item_id_fkey";

alter table "public"."inventory_expenses" add constraint "inventory_expenses_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES public.deals(id) not valid;

alter table "public"."inventory_expenses" validate constraint "inventory_expenses_deal_id_fkey";

alter table "public"."inventory_expenses" add constraint "inventory_expenses_item_id_fkey" FOREIGN KEY (item_id) REFERENCES public.inventory_items(id) not valid;

alter table "public"."inventory_expenses" validate constraint "inventory_expenses_item_id_fkey";

alter table "public"."inventory_items" add constraint "inventory_items_brand_id_fkey" FOREIGN KEY (brand_id) REFERENCES public.brands(id) not valid;

alter table "public"."inventory_items" validate constraint "inventory_items_brand_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.cash_flow_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

create or replace view "public"."inventory_items_search" as  SELECT i.id,
    i.brand_id,
    i.item_type,
    i.model,
    i.date_listed,
    i.sold_date,
    i.estimated_sold_value,
    i.collection_type,
    i.condition,
    i.status,
    i.notes,
    i.created_at,
    i.updated_at,
    i.year,
    i.color,
    b.name AS brand_name
   FROM (public.inventory_items i
     JOIN public.brands b ON ((b.id = i.brand_id)));


create or replace view "public"."inventory_items_with_value" as  SELECT i.id,
    i.brand_id,
    i.item_type,
    i.model,
    i.date_listed,
    i.sold_date,
    i.estimated_sold_value,
    i.collection_type,
    i.condition,
    i.status,
    i.notes,
    i.created_at,
    i.updated_at,
    i.year,
    i.color,
    di.total_value AS value_in
   FROM (public.inventory_items i
     LEFT JOIN public.deal_items di ON (((di.item_id = i.id) AND (di.direction = 'in'::text))));


grant delete on table "public"."brands" to "anon";

grant insert on table "public"."brands" to "anon";

grant references on table "public"."brands" to "anon";

grant select on table "public"."brands" to "anon";

grant trigger on table "public"."brands" to "anon";

grant truncate on table "public"."brands" to "anon";

grant update on table "public"."brands" to "anon";

grant delete on table "public"."brands" to "authenticated";

grant insert on table "public"."brands" to "authenticated";

grant references on table "public"."brands" to "authenticated";

grant select on table "public"."brands" to "authenticated";

grant trigger on table "public"."brands" to "authenticated";

grant truncate on table "public"."brands" to "authenticated";

grant update on table "public"."brands" to "authenticated";

grant delete on table "public"."brands" to "service_role";

grant insert on table "public"."brands" to "service_role";

grant references on table "public"."brands" to "service_role";

grant select on table "public"."brands" to "service_role";

grant trigger on table "public"."brands" to "service_role";

grant truncate on table "public"."brands" to "service_role";

grant update on table "public"."brands" to "service_role";

grant delete on table "public"."cash_flow" to "anon";

grant insert on table "public"."cash_flow" to "anon";

grant references on table "public"."cash_flow" to "anon";

grant select on table "public"."cash_flow" to "anon";

grant trigger on table "public"."cash_flow" to "anon";

grant truncate on table "public"."cash_flow" to "anon";

grant update on table "public"."cash_flow" to "anon";

grant delete on table "public"."cash_flow" to "authenticated";

grant insert on table "public"."cash_flow" to "authenticated";

grant references on table "public"."cash_flow" to "authenticated";

grant select on table "public"."cash_flow" to "authenticated";

grant trigger on table "public"."cash_flow" to "authenticated";

grant truncate on table "public"."cash_flow" to "authenticated";

grant update on table "public"."cash_flow" to "authenticated";

grant delete on table "public"."cash_flow" to "service_role";

grant insert on table "public"."cash_flow" to "service_role";

grant references on table "public"."cash_flow" to "service_role";

grant select on table "public"."cash_flow" to "service_role";

grant trigger on table "public"."cash_flow" to "service_role";

grant truncate on table "public"."cash_flow" to "service_role";

grant update on table "public"."cash_flow" to "service_role";

grant delete on table "public"."deal_items" to "anon";

grant insert on table "public"."deal_items" to "anon";

grant references on table "public"."deal_items" to "anon";

grant select on table "public"."deal_items" to "anon";

grant trigger on table "public"."deal_items" to "anon";

grant truncate on table "public"."deal_items" to "anon";

grant update on table "public"."deal_items" to "anon";

grant delete on table "public"."deal_items" to "authenticated";

grant insert on table "public"."deal_items" to "authenticated";

grant references on table "public"."deal_items" to "authenticated";

grant select on table "public"."deal_items" to "authenticated";

grant trigger on table "public"."deal_items" to "authenticated";

grant truncate on table "public"."deal_items" to "authenticated";

grant update on table "public"."deal_items" to "authenticated";

grant delete on table "public"."deal_items" to "service_role";

grant insert on table "public"."deal_items" to "service_role";

grant references on table "public"."deal_items" to "service_role";

grant select on table "public"."deal_items" to "service_role";

grant trigger on table "public"."deal_items" to "service_role";

grant truncate on table "public"."deal_items" to "service_role";

grant update on table "public"."deal_items" to "service_role";

grant delete on table "public"."deals" to "anon";

grant insert on table "public"."deals" to "anon";

grant references on table "public"."deals" to "anon";

grant select on table "public"."deals" to "anon";

grant trigger on table "public"."deals" to "anon";

grant truncate on table "public"."deals" to "anon";

grant update on table "public"."deals" to "anon";

grant delete on table "public"."deals" to "authenticated";

grant insert on table "public"."deals" to "authenticated";

grant references on table "public"."deals" to "authenticated";

grant select on table "public"."deals" to "authenticated";

grant trigger on table "public"."deals" to "authenticated";

grant truncate on table "public"."deals" to "authenticated";

grant update on table "public"."deals" to "authenticated";

grant delete on table "public"."deals" to "service_role";

grant insert on table "public"."deals" to "service_role";

grant references on table "public"."deals" to "service_role";

grant select on table "public"."deals" to "service_role";

grant trigger on table "public"."deals" to "service_role";

grant truncate on table "public"."deals" to "service_role";

grant update on table "public"."deals" to "service_role";

grant delete on table "public"."guitar_import_staging" to "anon";

grant insert on table "public"."guitar_import_staging" to "anon";

grant references on table "public"."guitar_import_staging" to "anon";

grant select on table "public"."guitar_import_staging" to "anon";

grant trigger on table "public"."guitar_import_staging" to "anon";

grant truncate on table "public"."guitar_import_staging" to "anon";

grant update on table "public"."guitar_import_staging" to "anon";

grant delete on table "public"."guitar_import_staging" to "authenticated";

grant insert on table "public"."guitar_import_staging" to "authenticated";

grant references on table "public"."guitar_import_staging" to "authenticated";

grant select on table "public"."guitar_import_staging" to "authenticated";

grant trigger on table "public"."guitar_import_staging" to "authenticated";

grant truncate on table "public"."guitar_import_staging" to "authenticated";

grant update on table "public"."guitar_import_staging" to "authenticated";

grant delete on table "public"."guitar_import_staging" to "service_role";

grant insert on table "public"."guitar_import_staging" to "service_role";

grant references on table "public"."guitar_import_staging" to "service_role";

grant select on table "public"."guitar_import_staging" to "service_role";

grant trigger on table "public"."guitar_import_staging" to "service_role";

grant truncate on table "public"."guitar_import_staging" to "service_role";

grant update on table "public"."guitar_import_staging" to "service_role";

grant delete on table "public"."inventory_expenses" to "anon";

grant insert on table "public"."inventory_expenses" to "anon";

grant references on table "public"."inventory_expenses" to "anon";

grant select on table "public"."inventory_expenses" to "anon";

grant trigger on table "public"."inventory_expenses" to "anon";

grant truncate on table "public"."inventory_expenses" to "anon";

grant update on table "public"."inventory_expenses" to "anon";

grant delete on table "public"."inventory_expenses" to "authenticated";

grant insert on table "public"."inventory_expenses" to "authenticated";

grant references on table "public"."inventory_expenses" to "authenticated";

grant select on table "public"."inventory_expenses" to "authenticated";

grant trigger on table "public"."inventory_expenses" to "authenticated";

grant truncate on table "public"."inventory_expenses" to "authenticated";

grant update on table "public"."inventory_expenses" to "authenticated";

grant delete on table "public"."inventory_expenses" to "service_role";

grant insert on table "public"."inventory_expenses" to "service_role";

grant references on table "public"."inventory_expenses" to "service_role";

grant select on table "public"."inventory_expenses" to "service_role";

grant trigger on table "public"."inventory_expenses" to "service_role";

grant truncate on table "public"."inventory_expenses" to "service_role";

grant update on table "public"."inventory_expenses" to "service_role";

grant delete on table "public"."inventory_items" to "anon";

grant insert on table "public"."inventory_items" to "anon";

grant references on table "public"."inventory_items" to "anon";

grant select on table "public"."inventory_items" to "anon";

grant trigger on table "public"."inventory_items" to "anon";

grant truncate on table "public"."inventory_items" to "anon";

grant update on table "public"."inventory_items" to "anon";

grant delete on table "public"."inventory_items" to "authenticated";

grant insert on table "public"."inventory_items" to "authenticated";

grant references on table "public"."inventory_items" to "authenticated";

grant select on table "public"."inventory_items" to "authenticated";

grant trigger on table "public"."inventory_items" to "authenticated";

grant truncate on table "public"."inventory_items" to "authenticated";

grant update on table "public"."inventory_items" to "authenticated";

grant delete on table "public"."inventory_items" to "service_role";

grant insert on table "public"."inventory_items" to "service_role";

grant references on table "public"."inventory_items" to "service_role";

grant select on table "public"."inventory_items" to "service_role";

grant trigger on table "public"."inventory_items" to "service_role";

grant truncate on table "public"."inventory_items" to "service_role";

grant update on table "public"."inventory_items" to "service_role";


  create policy "Allow authenticated users to manage inventory expenses"
  on "public"."inventory_expenses"
  as permissive
  for all
  to authenticated
using (true)
with check (true);


CREATE TRIGGER cash_flow_before_insert BEFORE INSERT ON public.cash_flow FOR EACH ROW EXECUTE FUNCTION public.cash_flow_before_insert();


