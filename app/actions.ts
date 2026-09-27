"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/supabase";

type DB = Awaited<ReturnType<typeof db>>;
type Result = PromiseLike<{ error: { message: string; code?: string } | null }>;

const id = z.uuid("Pick an option");
const qty = z.coerce.number().int().positive("Quantity must be at least 1");
const text = z.string().trim().min(1, "Fill in every field").max(120);

// validate -> one call to the db -> back to the dashboard with a message
async function run<S extends z.ZodType>(schema: S, input: unknown, call: (sb: DB, v: z.infer<S>) => Result, ok: string) {
  const parsed = schema.safeParse(input);
  let msg = ok;
  if (!parsed.success) msg = parsed.error.issues[0].message;
  else {
    const { error } = await call(await db(), parsed.data);
    // 23505 = unique violation (duplicate warehouse name or SKU)
    if (error) msg = error.code === "23505" ? "That already exists. Pick a different name or SKU." : error.message;
  }
  revalidatePath("/");
  redirect("/?msg=" + encodeURIComponent(msg));
}

const form = (f: FormData) => Object.fromEntries(f);

export async function createTenant(f: FormData) {
  await run(z.object({ name: text }), form(f), (sb, v) => sb.rpc("create_tenant", { p_name: v.name }), "Workspace created");
}

export async function addWarehouse(f: FormData) {
  await run(z.object({ name: text }), form(f), (sb, v) => sb.from("warehouses").insert(v), "Warehouse added");
}

export async function addProduct(f: FormData) {
  const schema = z.object({ sku: text, name: text, low_stock_threshold: z.coerce.number().int().min(0) });
  await run(schema, form(f), (sb, v) => sb.from("products").insert(v), "Product added");
}

export async function receiveStock(f: FormData) {
  await run(z.object({ warehouse_id: id, product_id: id, qty }), form(f),
    (sb, v) => sb.from("stock_movements").insert({ warehouse_id: v.warehouse_id, product_id: v.product_id, delta: v.qty, reason: "receive" }),
    "Stock received");
}

export async function transferStock(f: FormData) {
  const schema = z.object({ product: id, from: id, to: id, qty }).refine((v) => v.from !== v.to, "Pick two different warehouses");
  await run(schema, form(f),
    (sb, v) => sb.rpc("transfer_stock", { p_product: v.product, p_from: v.from, p_to: v.to, p_qty: v.qty }),
    "Transfer done");
}

export async function placeOrder(f: FormData) {
  const qtys = f.getAll("qty");
  const items = f.getAll("product").map((p, i) => ({ product_id: p, qty: qtys[i] })).filter((i) => i.product_id && i.qty);
  const schema = z.object({ warehouse: id, items: z.array(z.object({ product_id: id, qty })).min(1, "Add at least one line") });
  await run(schema, { warehouse: f.get("warehouse"), items },
    (sb, v) => sb.rpc("place_order", { p_warehouse: v.warehouse, p_items: v.items }), "Order placed, stock reserved");
}

export async function auth(f: FormData) {
  const creds = z.object({ email: z.email(), password: z.string().min(6) }).safeParse(form(f));
  if (!creds.success) redirect("/login?msg=" + encodeURIComponent(creds.error.issues[0].message));
  const sb = await db();
  const { data, error } = f.get("mode") === "signup"
    ? await sb.auth.signUp({
        ...creds.data,
        // where the confirmation email sends the user back to
        options: { emailRedirectTo: `${(await headers()).get("origin")}/auth/confirm` },
      })
    : await sb.auth.signInWithPassword(creds.data);
  if (error) redirect("/login?msg=" + encodeURIComponent(error.message));
  if (!data.session) redirect("/login?msg=" + encodeURIComponent("Check your inbox to confirm the email, then sign in"));
  redirect("/");
}

export async function signOut() {
  await (await db()).auth.signOut();
  redirect("/login");
}