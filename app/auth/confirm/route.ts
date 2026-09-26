import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { db } from "@/lib/supabase";

const back = (msg: string) => "/login?msg=" + encodeURIComponent(msg);

// The link in the confirmation email lands here.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const code = p.get("code");
  const tokenHash = p.get("token_hash");
  const type = p.get("type") as EmailOtpType | null;
  const sb = await db();

  // default email template: Supabase has already confirmed the email before sending the user here,
  // we just swap the code for a session. That only works in the browser they signed up in, so if it
  // fails (e.g. they opened the mail on their phone) the account is still confirmed - they just sign in.
  if (code) {
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (!error) redirect("/");
    redirect(back("Your email is confirmed. Sign in to continue."));
  }

  // custom template with token_hash: works from any device
  if (tokenHash && type) {
    const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) redirect("/");
    redirect(back(`${error.message}. If you already confirmed your email, just sign in.`));
  }

  // Supabase adds ?error_description=... when a link was already used or has expired
  const reason = p.get("error_description") ?? "This confirmation link is invalid or has expired";
  redirect(back(`${reason}. If you already confirmed your email, just sign in.`));
}