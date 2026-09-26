import { auth } from "../actions";

export default async function Login({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="text-2xl font-semibold">Stockroom</h1>
      <p className="mb-6 text-sm text-muted">Inventory and order fulfillment for your warehouses.</p>
      {msg && <p className="mb-4 rounded border border-line bg-white p-2 text-sm">{msg}</p>}
      <form action={auth} className="space-y-3">
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password (6+ characters)" required />
        <div className="flex gap-2">
          <button name="mode" value="signin">Sign in</button>
          <button name="mode" value="signup" className="bg-white text-brand ring-1 ring-brand">Create account</button>
        </div>
      </form>
    </main>
  );
}
