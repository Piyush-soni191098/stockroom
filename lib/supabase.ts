import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function db() {
  const jar = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_KEY!, {
    cookies: {
      getAll: () => jar.getAll(),
      // server components can't write cookies; proxy.ts handles the refresh there
      setAll: (list) => { try { list.forEach(({ name, value, options }) => jar.set(name, value, options)); } catch {} },
    },
  });
}
