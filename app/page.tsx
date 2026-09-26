import { redirect } from "next/navigation";
import { db } from "@/lib/supabase";
import * as act from "./actions";

type Opt = { id: string; label: string };

const Box = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="rounded-md border border-line bg-white p-4">
    <h2 className="mb-3 font-semibold">{title}</h2>
    {children}
  </section>
);

const Pick = ({ name, opts, hint }: { name: string; opts: Opt[]; hint: string }) => (
  <select name={name} defaultValue="">
    <option value="">{hint}</option>
    {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
  </select>
);

export default async function Home({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const sb = await db();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");

  const { data: tenant } = await sb.from("tenants").select("name").maybeSingle();
  if (!tenant) return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1 text-xl font-semibold">Set up your business</h1>
      <p className="mb-4 text-sm text-muted">This creates a private workspace. Only people in it can see its stock and orders.</p>
      {msg && <p className="mb-3 text-sm text-bad">{msg}</p>}
      <form action={act.createTenant} className="flex gap-2">
        <input name="name" placeholder="Business name" required />
        <button>Create</button>
      </form>
    </main>
  );

  // RLS scopes every one of these to the signed-in user's tenant; no tenant filter needed here
  const [wh, pr, st, fl, ord, mv] = await Promise.all([
    sb.from("warehouses").select("id, name").order("name"),
    sb.from("products").select("id, sku, name, low_stock_threshold").order("sku"),
    sb.from("stock").select("warehouse_id, product_id, qty"),
    sb.from("recon_flags").select("id, kind, warehouse_id, product_id, detail, created_at").is("resolved_at", null).order("created_at", { ascending: false }),
    sb.from("orders").select("id, warehouse_id, status, created_at, order_items(product_id, qty)").order("created_at", { ascending: false }).limit(10),
    sb.from("stock_movements").select("id, warehouse_id, product_id, delta, reason, created_at").order("id", { ascending: false }).limit(15),
  ]);
  const warehouses = wh.data ?? [], products = pr.data ?? [];
  const whName = Object.fromEntries(warehouses.map((w) => [w.id, w.name]));
  const sku = Object.fromEntries(products.map((p) => [p.id, p.sku]));
  const qtyOf = (w: string, p: string) => st.data?.find((s) => s.warehouse_id === w && s.product_id === p)?.qty ?? 0;
  const whOpts = warehouses.map((w) => ({ id: w.id, label: w.name }));
  const prOpts = products.map((p) => ({ id: p.id, label: `${p.sku} · ${p.name}` }));
  const when = (t: string) => new Date(t).toLocaleString();

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{tenant.name}</h1>
        <form action={act.signOut}><button className="bg-transparent text-muted hover:underline">Sign out {user.email}</button></form>
      </header>
      {msg && <p className="rounded border border-line bg-white p-2 text-sm">{msg}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Box title="Stock on hand">
            {products.length && warehouses.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-line text-left text-muted">
                    <th className="py-1.5">Product</th>
                    {warehouses.map((w) => <th key={w.id} className="text-right">{w.name}</th>)}
                  </tr></thead>
                  <tbody>{products.map((p) => (
                    <tr key={p.id} className="border-b border-line/60">
                      <td className="py-1.5">{p.sku} <span className="text-muted">{p.name}</span></td>
                      {warehouses.map((w) => {
                        const q = qtyOf(w.id, p.id);
                        return <td key={w.id} className={`text-right tabular-nums ${q <= p.low_stock_threshold ? "font-semibold text-warn" : ""}`}>{q}</td>;
                      })}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <p className="text-sm text-muted">Add a warehouse and a product to start tracking stock.</p>}
          </Box>

          <Box title="Reconciliation flags">
            {fl.data?.length ? (
              <ul className="space-y-1 text-sm">{fl.data.map((f) => (
                <li key={f.id} className={f.kind === "drift" ? "text-bad" : "text-warn"}>
                  <b>{f.kind.replace("_", " ")}</b> {sku[f.product_id]} in {whName[f.warehouse_id]} <span className="text-muted">{JSON.stringify(f.detail)}</span>
                </li>
              ))}</ul>
            ) : <p className="text-sm text-muted">Nothing flagged. The check runs every 15 minutes.</p>}
          </Box>

          <div className="grid gap-4 md:grid-cols-2">
            <Box title="Recent orders">
              <ul className="space-y-1 text-sm">{ord.data?.map((o) => (
                <li key={o.id}>
                  {when(o.created_at)} · {whName[o.warehouse_id]} ·{" "}
                  {o.order_items.map((i) => `${sku[i.product_id]} ×${i.qty}`).join(", ")} <span className="text-muted">({o.status})</span>
                </li>
              ))}</ul>
            </Box>
            <Box title="Movement history">
              <ul className="space-y-1 text-sm tabular-nums">{mv.data?.map((m) => (
                <li key={m.id}>
                  <span className={m.delta > 0 ? "text-brand" : "text-bad"}>{m.delta > 0 ? "+" : ""}{m.delta}</span>{" "}
                  {sku[m.product_id]} · {whName[m.warehouse_id]} · {m.reason.replace("_", " ")}
                </li>
              ))}</ul>
            </Box>
          </div>
        </div>

        <aside className="space-y-4">
          <Box title="Place order">
            <form action={act.placeOrder} className="space-y-2">
              <Pick name="warehouse" opts={whOpts} hint="Ship from…" />
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-2">
                  <Pick name="product" opts={prOpts} hint={i ? "Another product (optional)" : "Product…"} />
                  <input name="qty" type="number" min={1} placeholder="Qty" className="w-20!" />
                </div>
              ))}
              <button>Place order</button>
            </form>
          </Box>
          <Box title="Transfer between warehouses">
            <form action={act.transferStock} className="space-y-2">
              <Pick name="product" opts={prOpts} hint="Product…" />
              <Pick name="from" opts={whOpts} hint="From…" />
              <Pick name="to" opts={whOpts} hint="To…" />
              <input name="qty" type="number" min={1} placeholder="Quantity" />
              <button>Move stock</button>
            </form>
          </Box>
          <Box title="Receive stock">
            <form action={act.receiveStock} className="space-y-2">
              <Pick name="product_id" opts={prOpts} hint="Product…" />
              <Pick name="warehouse_id" opts={whOpts} hint="Into warehouse…" />
              <input name="qty" type="number" min={1} placeholder="Quantity" />
              <button>Receive</button>
            </form>
          </Box>
          <Box title="Add product">
            <form action={act.addProduct} className="space-y-2">
              <input name="sku" placeholder="SKU" />
              <input name="name" placeholder="Name" />
              <input name="low_stock_threshold" type="number" min={0} defaultValue={5} title="Flag as low stock at or below" />
              <button>Add product</button>
            </form>
          </Box>
          <Box title="Add warehouse">
            <form action={act.addWarehouse} className="flex gap-2">
              <input name="name" placeholder="Warehouse name" />
              <button>Add</button>
            </form>
          </Box>
        </aside>
      </div>
    </main>
  );
}
