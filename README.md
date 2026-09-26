   Live: https://stockroom-ebon.vercel.app
   Repo: https://github.com/Piyush-soni191098/stockroom

# Stockroom

Multi-tenant inventory and order fulfillment, built for the L3 screening brief. Several businesses share one app, each one only sees its own warehouses, products, stock and orders, and orders can't oversell even when they come in at the same time.

Live: https://YOUR-APP.vercel.app
Repo: https://github.com/YOUR-USERNAME/stockroom

## Stack

Next.js 16.2 (App Router + server actions), TypeScript 6.0, Tailwind v4, Zod 4 for validation, Supabase (Postgres 17 + Auth), Supabase Cron for the scheduled job, and Vercel for hosting. Node 24.

## The approach

I pushed almost all of the rules down into Postgres. The Next.js side is deliberately thin: it renders data, validates form input with Zod, and makes a single database call per action. Isolation, stock limits, transfers and reconciliation are all enforced by the database itself, so they still hold if someone skips the UI and calls the Supabase API directly.

Everything database-related is in `supabase/migrations/`.

## Database

The database is PostgreSQL 17, hosted on Supabase. Supabase also handles login (Supabase Auth), so the users themselves live in its built-in `auth.users` table, and everything else lives in the `public` schema.

There are 10 tables. Here's what each one stores (`→` means a foreign key):

```
tenants           one row per business
  id              uuid, primary key
  name            text
  created_at      timestamptz

profiles          which business a login user belongs to
  user_id         uuid, primary key → auth.users   (PK = one tenant per user)
  tenant_id       uuid → tenants

warehouses
  id              uuid, primary key
  tenant_id       uuid → tenants
  name            text

products          the catalog, not tied to any warehouse
  id              uuid, primary key
  tenant_id       uuid → tenants
  sku             text, unique within a tenant
  name            text
  low_stock_threshold  int, default 5

stock             current quantity, one row per warehouse + product
  warehouse_id    uuid  ┐ primary key
  product_id      uuid  ┘
  tenant_id       uuid
  qty             int, check (qty >= 0)
  updated_at      timestamptz (last movement, used for the "stale" check)

stock_movements   the append-only history of every stock change
  id              bigint, auto-increment
  tenant_id       uuid
  warehouse_id    uuid
  product_id      uuid
  delta           int, e.g. +10 or -3 (never 0)
  reason          'receive' | 'order' | 'transfer_out' | 'transfer_in'
  ref_id          uuid, points at the order or transfer that caused it
  created_at      timestamptz

transfers         one row per warehouse-to-warehouse move
  id              uuid, primary key
  tenant_id       uuid
  product_id      uuid
  from_warehouse  uuid
  to_warehouse    uuid, must differ from from_warehouse
  qty             int, > 0
  created_at      timestamptz

orders
  id              uuid, primary key
  tenant_id       uuid
  warehouse_id    uuid, the warehouse it ships from
  status          text, 'reserved'
  created_at      timestamptz

order_items       the lines of an order
  order_id        uuid  ┐ primary key
  product_id      uuid  ┘
  tenant_id       uuid
  qty             int, > 0

recon_flags       problems found by the scheduled job
  id              bigint, auto-increment
  tenant_id       uuid
  kind            'low_stock' | 'stale' | 'drift'
  warehouse_id    uuid
  product_id      uuid
  detail          jsonb, e.g. {"qty": 1, "threshold": 2}
  created_at      timestamptz
  resolved_at     timestamptz, null while the flag is open
```

Every table except `tenants` and `profiles` has a `tenant_id`, and every reference to a warehouse, product or order uses a composite key like `(tenant_id, warehouse_id)`. That's what stops a row in one tenant from pointing at something in another (more on that below).

`stock` is really a running total of `stock_movements`. The app never writes to it. A trigger on `stock_movements` updates it every time a movement is inserted. So if you receive 10 T-shirts into Jaipur and then order 3, this is what ends up in the database:

```
stock_movements
  +10  receive  Jaipur  TSH-01
   -3  order    Jaipur  TSH-01   ref_id = the order's id

stock
  Jaipur  TSH-01  qty = 7
```

A new product has no `stock` rows at all, which the dashboard shows as 0. The row only appears the first time stock is received into a warehouse.

The database functions the app calls:

- `create_tenant(name)`: creates the business and links the current user to it
- `place_order(warehouse, items)`: creates the order and reserves stock, all or nothing
- `transfer_stock(product, from, to, qty)`: one transfer record plus both movements, all or nothing
- `reconcile()`: the scheduled check (only the cron job can run it)
- `my_tenant()`: returns the current user's tenant id, used by all the RLS policies

## Tenant isolation

There's no `where tenant_id = ...` anywhere in the app code, on purpose. It's all done in the database:

- Every tenant-owned table has a `tenant_id` column that defaults to `my_tenant()`. That function takes the user id from the Supabase JWT (`auth.uid()`) and looks up their tenant in `profiles`. The app never sends a tenant id.
- RLS is on for every table, with policies of the form `tenant_id = my_tenant()` for both reads and writes. A query with a missing or broken WHERE clause still only returns your own rows, and inserting a row with someone else's `tenant_id` fails.
- Foreign keys are composite, e.g. `(tenant_id, warehouse_id) -> warehouses(tenant_id, id)`. So even if you know another tenant's warehouse UUID, you can't place an order against it, because that warehouse doesn't exist in your tenant.
- `stock` can't be written by users at all (only the trigger), and `stock_movements` has no update or delete. I also revoked `TRUNCATE`, since RLS doesn't cover it.
- `place_order` and `transfer_stock` run as the calling user, so RLS applies inside them too. The only `security definer` functions are `my_tenant()`, `create_tenant()`, the stock trigger, and `reconcile()`, which normal users can't execute.

`npm run verify` tests this adversarially. It logs in as a second tenant and goes after the first tenant's data through the API: reading products and stock, updating a product, inserting a warehouse with the other tenant's id, and ordering from their warehouse. Reads come back empty, the update touches 0 rows, and the inserts error out.

## What stops two orders from taking the last unit

`place_order` is a single Postgres function, so it's one transaction. It inserts the order and its items, then a negative stock movement per item. The trigger on that movement does the actual decrement:

```sql
update stock
set qty = qty + new.delta              -- delta is negative
where warehouse_id = new.warehouse_id
  and product_id = new.product_id
  and qty + new.delta >= 0;            -- never below zero

if not found then
  raise exception 'insufficient stock ...';
end if;
```

The check and the write are the same statement, so there's no read-then-write gap for a race to slip into.

With 1 unit left and two orders, X and Y, arriving together:

1. X's update matches the row, sets qty to 0 and holds the row lock.
2. Y's update reaches the same row and waits for X's lock.
3. X commits. Under READ COMMITTED, Postgres re-evaluates Y's WHERE against the committed row: `0 - 1 >= 0` is false, so zero rows are updated.
4. Y raises "insufficient stock" and its whole transaction rolls back, order row included. That message goes back to the user.

There's also a `check (qty >= 0)` on `stock` as a backstop. For multi-line orders, movements are written in product id order (and transfers in warehouse id order), so concurrent transactions always lock rows in the same order and can't deadlock each other.

The verify script fires 20 orders at once for a product with 1 unit in stock. 1 goes through, 19 get "insufficient stock", and stock ends at 0.

## Transfers

`transfer_stock` writes one row to `transfers` and two movements (`transfer_out`, `transfer_in`) that point back to it via `ref_id`. It's one function call, so if the source warehouse doesn't have enough, the whole thing rolls back. Stock can't leave one warehouse without arriving in the other.

## Reconciliation

`reconcile()` runs every 15 minutes through Supabase Cron and flags three things per item:

- `low_stock`: qty at or below the product's threshold
- `stale`: stock on hand but no movement in 30 days
- `drift`: `stock.qty` doesn't match `sum(delta)` from the movement history

The drift check is a real recount from the ledger, so it catches any write to `stock` that didn't go through a movement (a manual SQL fix, a bad script, etc.). The verify script fakes one of these to prove it gets caught.

It's safe to run repeatedly. A partial unique index allows only one open flag per (kind, warehouse, product), new flags go in with `on conflict do nothing`, and flags whose problem has cleared get marked resolved. A second run straight after the first inserts nothing.

I used Supabase Cron (pg_cron) rather than Vercel Cron because the job is plain SQL, so it doesn't need an HTTP endpoint or a secret to protect it. Vercel's free tier also only runs crons once a day.

## Running it locally

You'll need:

- Node.js 24 (npm comes with it)
- Git
- A free Supabase project on Postgres 17
- A Vercel account if you want to deploy

`npm install` pulls everything else from `package.json`: `next`, `react`, `@supabase/supabase-js`, `@supabase/ssr` for the cookie-based session, and `zod`, plus `typescript`, `tailwindcss` and the type packages as dev dependencies. The Supabase CLI runs through `npx`, so there's nothing extra to install for it.

Get the code and install:

```bash
git clone https://github.com/YOUR-USERNAME/stockroom.git
cd stockroom
npm install
```

npm might warn about `sharp` install scripts. It's safe to ignore; the app doesn't use Next's image optimization.

In the Supabase dashboard, create a project and save the database password. Then go to Authentication > Sign In / Providers > Email and turn off "Confirm email". Otherwise every sign-up waits on an email, and you'll hit Supabase's email rate limit quickly.

Add your keys:

```bash
cp .env.example .env
```

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_KEY=<publishable key>
SUPABASE_SERVICE_KEY=<secret key>
```

Both keys are under Project Settings > API Keys. The secret key is only used by the test script; keep it out of git and out of Vercel.

Create the database:

```bash
npx supabase login
npx supabase init
npx supabase link --project-ref <project-ref>
npx supabase db push
```

If `db push` fails with "failed to connect to postgres", your network probably doesn't have IPv6, which Supabase's direct DB host needs. That happened to me, so I ran the migrations from the SQL Editor instead:

1. Paste `supabase/migrations/20260926000000_init.sql` into a new query and run it.
2. Do the same with `20260926000100_cron.sql`.
3. Run `notify pgrst, 'reload schema';` so the API picks up the new functions.

Start the app:

```bash
npm run dev
```

It runs on http://localhost:3000, or the next free port if that's taken.

Then, in a second terminal, run the tests:

```bash
npm run verify
```

Every line should print PASS.

Other scripts: `npm run build` for a production build (it also type-checks), and `npm run start` to serve that build.

### Deploying

```bash
npm i -g vercel
vercel login
vercel
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_KEY production
vercel --prod
```

After that, set the Vercel URL as the Site URL in Supabase under Authentication > URL Configuration.

### Problems I ran into

- **"email rate limit exceeded"**: email confirmation is still on. Turn it off, or create the user from Authentication > Users with "Auto Confirm User" ticked.
- **"Could not find the function public.create_tenant"**: the migrations haven't been applied yet.
- **"Invalid login credentials" right after signing up**: the account is stuck waiting for confirmation. Delete it and sign up again once confirmation is off.

## Quick walkthrough

1. Sign up and create a business.
2. Add two warehouses, say Jaipur and Jodhpur, and a product (TSH-01, T-shirt, alert level 2).
3. Receive 10 into Jaipur, then transfer 4 to Jodhpur. Jaipur shows 6 and Jodhpur shows 4.
4. Try transferring 50. You get "insufficient stock" and nothing changes.
5. Order 4 from Jodhpur. It drops to 0 and turns orange. A second order from Jodhpur is rejected.
6. Sign out and create another business. It can't see any of the first one's data.

## Layout

```
supabase/migrations/   schema, RLS, functions, trigger, cron
app/page.tsx           dashboard
app/login/page.tsx     sign in / sign up
app/actions.ts         server actions (Zod + one db call each)
lib/supabase.ts        server-side Supabase client
proxy.ts               refreshes the auth session
scripts/verify.mjs     isolation, race and reconciliation tests
```

## How to use it

### Getting in

Open the app and create an account with your email and a password (6+ characters). If email confirmation is on, you'll get a link by email. Click it and you're signed in. Next you're asked for a business name. That creates your workspace, and you're the only one who can see what's in it.

### Setting up

Everything you do is on the right side of the dashboard. Start at the bottom:

- **Add warehouse**: one for each place you keep stock, e.g. Jaipur and Jodhpur.
- **Add product**: a SKU (short code like `TSH-01`), a name, and the alert level. When stock in a warehouse drops to that number or below, it turns orange and gets flagged.

Adding a product doesn't put it in any warehouse. It starts at 0 everywhere.

### Day-to-day

- **Receive stock**: when a delivery arrives. Pick the product, the warehouse and how many came in.
- **Transfer between warehouses**: moves units from one warehouse to another in one go. If the source doesn't have enough, nothing moves.
- **Place order**: pick the warehouse it ships from and up to three products with quantities. The stock is reserved immediately. If any line is short, the whole order is rejected with "insufficient stock" and nothing is reserved.

### Reading the dashboard

- **Stock on hand**: products down the side, warehouses across the top. Orange numbers are at or below the alert level.
- **Reconciliation flags**: what the automatic check found. It runs every 15 minutes and looks for low stock, stock that hasn't moved in 30 days, and counts that don't match the history (shown in red).
- **Recent orders**: the last 10 orders and what was in them.
- **Movement history**: every change, newest first. `+` is stock coming in, `-` is stock going out, and each transfer shows up as a matching out/in pair.

### A quick run-through

1. Add warehouses Jaipur and Jodhpur, and a product TSH-01 / T-shirt with alert level 2.
2. Receive 10 into Jaipur, then transfer 4 to Jodhpur. You'll see 6 and 4.
3. Try transferring 50. You get "insufficient stock" and the numbers don't change.
4. Order 4 from Jodhpur. It drops to 0 and turns orange. Another order from Jodhpur is rejected.
5. Sign out and create a second business. It starts completely empty and can't see anything from the first one.

### Running the tests

`scripts/verify.mjs` checks the three things the brief cares most about, against the real database. With the app's `.env` filled in, including the secret key, run:

```bash
npm run verify
```

It creates two throwaway businesses and then:

- has the second one try to read, edit and write into the first one's data (isolation)
- fires 20 orders at the same moment for the last unit in stock (race)
- runs the reconciliation job twice, then fakes a bad stock count and runs it again (idempotency and drift)

Each check prints PASS or FAIL. All of them should pass.
