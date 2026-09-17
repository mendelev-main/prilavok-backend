import { createHash, randomBytes } from "node:crypto";

export const PHONE_VERIFICATION_TTL_MS = 5 * 60 * 1000;
const TELEGRAM_BOT_USERNAME = "project_account_bot";

export function createPhoneVerificationService(supabase, normalizePhone) {
  const hashToken = token => createHash("sha256").update(String(token)).digest("hex");
  const nowIso = () => new Date().toISOString();

  async function create(phone, returnUrl = null) {
    const normalized = normalizePhone(phone);
    if (!normalized) return { error: "Некорректный номер телефона", status: 400 };

    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + PHONE_VERIFICATION_TTL_MS).toISOString();

    const { error } = await supabase.from("phone_verifications").insert({
      token_hash: tokenHash,
      phone: normalized,
      status: "PENDING",
      expires_at: expiresAt,
      return_url: returnUrl || null,
    });
    if (error) throw error;

    return {
      token,
      status: "PENDING",
      expiresAt,
      telegramUrl: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(token)}`,
    };
  }

  async function get(token) {
    const tokenHash = hashToken(token);
    const { data, error } = await supabase.from("phone_verifications")
      .select("id,phone,status,expires_at,verified_at,return_url,telegram_user_id")
      .eq("token_hash", tokenHash).maybeSingle();
    if (error) throw error;
    if (!data) return null;

    if (data.status === "PENDING" && new Date(data.expires_at).getTime() <= Date.now()) {
      await supabase.from("phone_verifications").update({ status: "EXPIRED" }).eq("id", data.id).eq("status", "PENDING");
      data.status = "EXPIRED";
    }
    return data;
  }

  async function confirm(token, phone, telegramUserId) {
    const normalized = normalizePhone(phone);
    if (!normalized || !telegramUserId) return { ok: false, reason: "INVALID" };

    const verification = await get(token);
    if (!verification || verification.status !== "PENDING") return { ok: false, reason: verification?.status || "NOT_FOUND" };
    if (verification.phone !== normalized) return { ok: false, reason: "PHONE_MISMATCH" };

    const verifiedAt = nowIso();
    const { data, error } = await supabase.from("phone_verifications")
      .update({ status: "VERIFIED", verified_at: verifiedAt, telegram_user_id: String(telegramUserId) })
      .eq("id", verification.id).eq("status", "PENDING")
      .select("id,status,verified_at,return_url,telegram_user_id").maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, reason: "ALREADY_USED" };

    return { ok: true, status: "VERIFIED", verifiedAt: data.verified_at, returnUrl: data.return_url || null, telegramUserId: data.telegram_user_id || null };
  }

  async function consume(token, phone) {
    const normalized = normalizePhone(phone);
    const verification = await get(token);
    if (!verification || verification.status !== "VERIFIED" || verification.phone !== normalized) return false;

    const { data, error } = await supabase.from("phone_verifications")
      .update({ status: "CONSUMED", consumed_at: nowIso() })
      .eq("id", verification.id).eq("status", "VERIFIED")
      .select("id").maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  return { create, get, confirm, consume };
}
