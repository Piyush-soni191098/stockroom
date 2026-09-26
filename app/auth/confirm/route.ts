import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { db } from "@/lib/supabase";

// The link in the confirmation email lands here. Supabase sends either
// ?code=... (default email template) or ?token_hash=...&type=... (custom template).
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;
  const sb = await db();

  let error = "Confirmation link is invalid or has expired";
  if (code) error = (await sb.auth.exchangeCodeForSession(code)).error?.message ?? "";
  else if (tokenHash && type) error = (await sb.auth.verifyOtp({ token_hash: tokenHash, type })).error?.message ?? "";

  redirect(error ? "/login?msg=" + encodeURIComponent(error) : "/");
}