// Adversarial checks against a real Supabase project:
//   node --env-file=.env.local scripts/verify.mjs
// 1. tenant B cannot read or write tenant A's rows through the public API
// 2. 20 simultaneous orders for the last unit -> exactly 1 succeeds
// 3. reconcile() twice in a row creates no duplicate flags, and catches real drift
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_KEY;
const admin = createClient(url, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) failed++; };

async function tenantUser(tag) {
  const email = `verify-${tag}-${Date.now()}@example.com`, password = "verify-pass-123";
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const sb = createClient(url, key, { auth: { persistSession: false } });
  await sb.auth.signInWithPassword({ email, password });
  await sb.rpc("create_tenant", { p_name: `Verify ${tag}` });
  return sb;
}

const a = await tenantUser("a"), b = await tenantUser("b");
const { data: wh } = await a.from("warehouses").insert({ name: "Main" }).select().single();
const { data: pr } = await a.from("products").insert({ sku: `LAST-${Date.now()}`, name: "Last unit", low_stock_threshold: 2 }).select().single();
await a.from("stock_movements").insert({ warehouse_id: wh.id, product_id: pr.id, delta: 1, reason: "receive" });

// --- 1. isolation
const read = await b.from("products").select().eq("id", pr.id);
check("B cannot read A's product", read.data?.length === 0);
const stock = await b.from("stock").select().eq("warehouse_id", wh.id);
check("B cannot read A's stock", stock.data?.length === 0);
const upd = await b.from("products").update({ name: "pwned" }).eq("id", pr.id).select();
check("B cannot update A's product", upd.data?.length === 0);
const { data: aTenant } = await a.from("tenants").select("id").single();
const ins = await b.from("warehouses").insert({ tenant_id: aTenant.id, name: "sneaky" });
check("B cannot insert into A's tenant", !!ins.error, ins.error?.message);
const ord = await b.rpc("place_order", { p_warehouse: wh.id, p_items: [{ product_id: pr.id, qty: 1 }] });
check("B cannot order from A's warehouse", !!ord.error, ord.error?.message);
const direct = await a.from("stock").update({ qty: 999 }).eq("warehouse_id", wh.id);
check("A cannot edit stock directly (ledger only)", !!direct.error, direct.error?.message);

// --- 2. race for the last unit
const results = await Promise.all(Array.from({ length: 20 }, () =>
  a.rpc("place_order", { p_warehouse: wh.id, p_items: [{ product_id: pr.id, qty: 1 }] })));
const wins = results.filter((r) => !r.error).length;
const clean = results.filter((r) => r.error?.message.includes("insufficient stock")).length;
check("exactly one of 20 concurrent orders succeeds", wins === 1, `(${wins} won, ${clean} got "insufficient stock")`);
const { data: left } = await a.from("stock").select("qty").eq("warehouse_id", wh.id).single();
check("stock ends at 0, never negative", left.qty === 0);

// --- 3. reconciliation
const openFlags = async () => (await admin.from("recon_flags").select("id").eq("product_id", pr.id).is("resolved_at", null)).data.length;
await admin.rpc("reconcile");
const first = await openFlags();
await admin.rpc("reconcile");
check("reconcile twice -> no duplicate flags", first === (await openFlags()), `(${first} open)`);
await admin.from("stock").update({ qty: 42 }).eq("warehouse_id", wh.id); // simulate a bad out-of-band write
await admin.rpc("reconcile");
await admin.rpc("reconcile");
const drift = await admin.from("recon_flags").select("detail").eq("product_id", pr.id).eq("kind", "drift").is("resolved_at", null);
check("drift between stock and ledger is flagged once", drift.data.length === 1, JSON.stringify(drift.data[0]?.detail));

process.exit(failed ? 1 : 0);
