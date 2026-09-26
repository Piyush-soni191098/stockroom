-- Tenancy -----------------------------------------------------------------

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- user_id is the PK, so a user can only ever belong to one tenant
create table public.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  tenant_id uuid not null references public.tenants
);

-- security definer: policies call this, and it must not be blocked by profiles' own RLS
create function public.my_tenant() returns uuid
language sql stable security definer set search_path = '' as $$
  select tenant_id from public.profiles where user_id = auth.uid()
$$;

create function public.create_tenant(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t uuid;
begin
  if public.my_tenant() is not null then raise exception 'you already belong to a workspace'; end if;
  insert into public.tenants (name) values (p_name) returning id into t;
  insert into public.profiles (user_id, tenant_id) values (auth.uid(), t);
  return t;
end $$;

-- Catalog -------------------------------------------------------------------
-- tenant_id defaults to the caller's tenant, so the app never sends it.
-- unique (tenant_id, id) lets child tables use composite FKs: a row can't point
-- at a warehouse/product from another tenant even if someone passes its uuid.

create table public.warehouses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.my_tenant() references public.tenants,
  name text not null,
  unique (tenant_id, id)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.my_tenant() references public.tenants,
  sku text not null,
  name text not null,
  low_stock_threshold int not null default 5 check (low_stock_threshold >= 0),
  unique (tenant_id, sku),
  unique (tenant_id, id)
);

-- Stock + ledger --------------------------------------------------------------

-- on-hand per warehouse; only the ledger trigger writes to it
create table public.stock (
  tenant_id uuid not null references public.tenants,
  warehouse_id uuid not null,
  product_id uuid not null,
  qty int not null check (qty >= 0),
  updated_at timestamptz not null default now(),
  primary key (warehouse_id, product_id),
  foreign key (tenant_id, warehouse_id) references public.warehouses (tenant_id, id),
  foreign key (tenant_id, product_id) references public.products (tenant_id, id)
);

-- append-only: no update/delete policy exists, so nobody can rewrite history
create table public.stock_movements (
  id bigint generated always as identity primary key,
  tenant_id uuid not null default public.my_tenant() references public.tenants,
  warehouse_id uuid not null,
  product_id uuid not null,
  delta int not null check (delta <> 0),
  reason text not null check (reason in ('receive', 'transfer_out', 'transfer_in', 'order')),
  ref_id uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, warehouse_id) references public.warehouses (tenant_id, id),
  foreign key (tenant_id, product_id) references public.products (tenant_id, id)
);
create index on public.stock_movements (warehouse_id, product_id);

-- Every movement goes through here. Debits are a conditional UPDATE: the WHERE
-- refuses to take qty below zero and we check the row count. Two debits on the
-- same row queue on its row lock; the second re-evaluates the WHERE against the
-- committed qty, matches nothing, and raises. That's the whole oversell guard.
create function public.apply_movement() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.delta > 0 then
    insert into public.stock as s (tenant_id, warehouse_id, product_id, qty)
    values (new.tenant_id, new.warehouse_id, new.product_id, new.delta)
    on conflict (warehouse_id, product_id)
    do update set qty = s.qty + excluded.qty, updated_at = now();
  else
    update public.stock set qty = qty + new.delta, updated_at = now()
    where warehouse_id = new.warehouse_id and product_id = new.product_id
      and qty + new.delta >= 0;
    if not found then
      raise exception 'insufficient stock for product %', new.product_id using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create trigger apply_movement after insert on public.stock_movements
for each row execute function public.apply_movement();

-- Transfers -------------------------------------------------------------------

create table public.transfers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.my_tenant() references public.tenants,
  product_id uuid not null,
  from_warehouse uuid not null,
  to_warehouse uuid not null,
  qty int not null check (qty > 0),
  created_at timestamptz not null default now(),
  check (from_warehouse <> to_warehouse),
  foreign key (tenant_id, product_id) references public.products (tenant_id, id),
  foreign key (tenant_id, from_warehouse) references public.warehouses (tenant_id, id),
  foreign key (tenant_id, to_warehouse) references public.warehouses (tenant_id, id)
);

-- one function call = one transaction: the transfer row and both legs commit together or not at all
create function public.transfer_stock(p_product uuid, p_from uuid, p_to uuid, p_qty int) returns uuid
language plpgsql set search_path = '' as $$
declare t uuid;
begin
  insert into public.transfers (product_id, from_warehouse, to_warehouse, qty)
  values (p_product, p_from, p_to, p_qty) returning id into t;
  -- touch rows in warehouse-id order so A->B and B->A running together can't deadlock
  insert into public.stock_movements (warehouse_id, product_id, delta, reason, ref_id)
  select w, p_product, d, r, t
  from (values (p_from, -p_qty, 'transfer_out'), (p_to, p_qty, 'transfer_in')) v (w, d, r)
  order by w;
  return t;
end $$;

-- Orders ----------------------------------------------------------------------

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.my_tenant() references public.tenants,
  warehouse_id uuid not null,
  status text not null default 'reserved',
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, warehouse_id) references public.warehouses (tenant_id, id)
);

create table public.order_items (
  order_id uuid not null,
  tenant_id uuid not null default public.my_tenant() references public.tenants,
  product_id uuid not null,
  qty int not null check (qty > 0),
  primary key (order_id, product_id),
  foreign key (tenant_id, order_id) references public.orders (tenant_id, id),
  foreign key (tenant_id, product_id) references public.products (tenant_id, id)
);

-- p_items: [{"product_id": "...", "qty": 2}, ...]
-- any line short on stock raises inside the trigger and the whole order rolls back
create function public.place_order(p_warehouse uuid, p_items jsonb) returns uuid
language plpgsql set search_path = '' as $$
declare o uuid;
begin
  insert into public.orders (warehouse_id) values (p_warehouse) returning id into o;
  insert into public.order_items (order_id, product_id, qty)
  select o, (i ->> 'product_id')::uuid, sum((i ->> 'qty')::int)
  from jsonb_array_elements(p_items) i group by 2;
  if not found then raise exception 'order has no items'; end if;
  insert into public.stock_movements (warehouse_id, product_id, delta, reason, ref_id)
  select p_warehouse, product_id, -qty, 'order', o
  from public.order_items where order_id = o
  order by product_id; -- fixed lock order again
  return o;
end $$;

-- Reconciliation ------------------------------------------------------------------

create table public.recon_flags (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants,
  kind text not null check (kind in ('low_stock', 'stale', 'drift')),
  warehouse_id uuid not null,
  product_id uuid not null,
  detail jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
-- at most one open flag per (kind, item): this index is what makes the job idempotent
create unique index open_flag on public.recon_flags (kind, warehouse_id, product_id) where resolved_at is null;

create function public.reconcile() returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  with ledger as (
    select warehouse_id, product_id, sum(delta) as total
    from public.stock_movements group by 1, 2
  ), found as (
    select s.tenant_id, 'low_stock' as kind, s.warehouse_id, s.product_id,
           jsonb_build_object('qty', s.qty, 'threshold', p.low_stock_threshold) as detail
    from public.stock s join public.products p on p.id = s.product_id
    where s.qty <= p.low_stock_threshold
    union all
    select tenant_id, 'stale', warehouse_id, product_id, jsonb_build_object('last_movement', updated_at)
    from public.stock where qty > 0 and updated_at < now() - interval '30 days'
    union all
    -- real drift check: the cached qty must equal the sum of the ledger
    select s.tenant_id, 'drift', s.warehouse_id, s.product_id,
           jsonb_build_object('stock', s.qty, 'ledger', coalesce(l.total, 0))
    from public.stock s left join ledger l using (warehouse_id, product_id)
    where s.qty <> coalesce(l.total, 0)
  ), closed as (
    update public.recon_flags f set resolved_at = now()
    where resolved_at is null and not exists (
      select 1 from found x
      where (x.kind, x.warehouse_id, x.product_id) = (f.kind, f.warehouse_id, f.product_id))
  )
  insert into public.recon_flags (tenant_id, kind, warehouse_id, product_id, detail)
  select * from found
  on conflict (kind, warehouse_id, product_id) where resolved_at is null do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- RLS -------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['tenants', 'profiles', 'warehouses', 'products', 'stock',
                           'stock_movements', 'transfers', 'orders', 'order_items', 'recon_flags'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke truncate on public.%I from anon, authenticated', t); -- truncate ignores RLS
  end loop;

  foreach t in array array['warehouses', 'products', 'stock', 'stock_movements',
                           'transfers', 'orders', 'order_items', 'recon_flags'] loop
    execute format('create policy "read own tenant" on public.%I for select to authenticated
                    using (tenant_id = (select public.my_tenant()))', t);
  end loop;

  foreach t in array array['warehouses', 'products', 'stock_movements', 'transfers', 'orders', 'order_items'] loop
    execute format('create policy "insert into own tenant" on public.%I for insert to authenticated
                    with check (tenant_id = (select public.my_tenant()))', t);
  end loop;

  foreach t in array array['warehouses', 'products'] loop
    execute format('create policy "edit own tenant" on public.%I for update to authenticated
                    using (tenant_id = (select public.my_tenant()))
                    with check (tenant_id = (select public.my_tenant()))', t);
  end loop;
end $$;

create policy "own tenant" on public.tenants for select to authenticated using (id = (select public.my_tenant()));
create policy "own profile" on public.profiles for select to authenticated using (user_id = (select auth.uid()));

-- explicit grants (don't rely on project defaults); RLS then narrows these to one tenant
grant select, insert, update on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
-- stock only changes through the ledger trigger; reconcile is for the cron job only
revoke insert, update, delete on public.stock from anon, authenticated;
revoke update, delete on public.stock_movements from anon, authenticated;
revoke execute on function public.reconcile() from public, anon, authenticated;
revoke execute on function public.create_tenant(text) from public, anon;
