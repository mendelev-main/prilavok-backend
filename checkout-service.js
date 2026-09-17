import { createHash, randomBytes, randomUUID } from "node:crypto";

export const CHECKOUT_TTL_MS = 5 * 60 * 1000;

export function createCheckoutService({ supabase, normalizePhone, validateOrderContact, phoneVerification, deliveryFee = 0 }) {
  const hash = value => createHash("sha256").update(String(value)).digest("hex");

  async function prepareOrder(payload) {
    const orderType = String(payload?.orderType || "Самовывоз").trim();
    const customerName = String(payload?.customerName || "").trim();
    const rawPhone = String(payload?.phone || "").trim();
    const phone = normalizePhone(rawPhone);
    const address = String(payload?.address || "").trim();
    const comment = String(payload?.comment || "").trim();
    const requestedItems = Array.isArray(payload?.items) ? payload.items : [];

    if (!customerName || !phone || !requestedItems.length) return { error: "Заполните данные заказа и добавьте товары", status: 400 };
    if (orderType === "Доставка" && !address) return { error: "Укажите адрес доставки", status: 400 };
    const contactError = validateOrderContact({ phone: rawPhone, comment, items: requestedItems });
    if (contactError) return { error: contactError, status: 400 };

    const ids = requestedItems.map(x => String(x.productId || "").trim()).filter(Boolean);
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length || uniqueIds.length !== ids.length) return { error: "Некорректные товары в заказе", status: 400 };

    const { data: products, error: productsError } = await supabase.from("products")
      .select("id,external_id,name,price")
      .in("id", uniqueIds)
      .eq("is_active", true)
      .eq("available_online", true);
    if (productsError) throw productsError;
    const productMap = new Map((products || []).map(p => [p.id, p]));
    if (productMap.size !== uniqueIds.length) return { error: "Один из товаров больше недоступен для заказа", status: 400 };

    const items = [];
    let subtotal = 0;
    for (const raw of requestedItems) {
      const product = productMap.get(String(raw.productId));
      const quantity = Number(raw.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 99) return { error: "Некорректное количество товара", status: 400 };
      subtotal += Number(product.price || 0) * quantity;
      items.push({
        product_id: product.id,
        external_product_id: product.external_id,
        product_name: product.name,
        price: Number(product.price || 0),
        quantity,
        comment: raw.comment ? String(raw.comment).trim().slice(0, 500) : null,
      });
    }

    const fee = orderType === "Доставка" ? (Number.isFinite(Number(deliveryFee)) ? Number(deliveryFee) : 0) : 0;
    return {
      order: { orderType, customerName, phone, address: orderType === "Доставка" ? address : "", comment, items, subtotal, fee, total: subtotal + fee },
    };
  }

  async function create(payload, returnBaseUrl) {
    const prepared = await prepareOrder(payload);
    if (prepared.error) return prepared;

    const checkoutToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS).toISOString();
    const returnUrl = `${String(returnBaseUrl || "").replace(/\/+$/, "")}/?checkout=${encodeURIComponent(checkoutToken)}`;
    const verification = await phoneVerification.create(prepared.order.phone, returnUrl);
    if (verification.error) return verification;

    const { error } = await supabase.from("checkout_sessions").insert({
      token_hash: hash(checkoutToken),
      phone: prepared.order.phone,
      status: "PENDING",
      order_payload: prepared.order,
      verification_token_hash: hash(verification.token),
      expires_at: expiresAt,
    });
    if (error) throw error;

    return { checkoutToken, status: "PENDING", expiresAt, telegramUrl: verification.telegramUrl };
  }

  async function get(checkoutToken) {
    const { data, error } = await supabase.from("checkout_sessions")
      .select("id,status,expires_at,tracking_token,order_id")
      .eq("token_hash", hash(checkoutToken))
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if ((data.status === "PENDING" || data.status === "VERIFIED") && new Date(data.expires_at).getTime() <= Date.now()) {
      await supabase.from("checkout_sessions").update({ status: "EXPIRED", updated_at: new Date().toISOString() }).eq("id", data.id);
      data.status = "EXPIRED";
    }
    return data;
  }

  async function finalizeByVerificationToken(verificationToken) {
    const verificationHash = hash(verificationToken);
    const { data: session, error } = await supabase.from("checkout_sessions")
      .select("id,status,phone,order_payload,expires_at,tracking_token,order_id")
      .eq("verification_token_hash", verificationHash)
      .maybeSingle();
    if (error) throw error;
    if (!session) return null;
    if (session.status === "ORDER_CREATED") return { ok: true, trackingToken: session.tracking_token, orderId: session.order_id };
    if (session.status !== "PENDING" || new Date(session.expires_at).getTime() <= Date.now()) return { ok: false, reason: "EXPIRED" };

    const verification = await phoneVerification.get(verificationToken);
    if (!verification || verification.status !== "VERIFIED" || verification.phone !== session.phone) return { ok: false, reason: "NOT_VERIFIED" };

    const consumed = await phoneVerification.consume(verificationToken, session.phone);
    if (!consumed) return { ok: false, reason: "ALREADY_USED" };

    const order = session.order_payload || {};
    const externalId = `WEB-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const trackingToken = randomUUID().replace(/-/g, "");
    const { data: created, error: orderError } = await supabase.from("orders").insert({
      external_id: externalId,
      tracking_token: trackingToken,
      status: "new",
      order_type: order.orderType,
      customer_name: order.customerName,
      phone: session.phone,
      address: order.orderType === "Доставка" ? order.address : null,
      comment: order.comment || null,
      total: Number(order.total || 0),
      delivery_fee: Number(order.fee || 0),
    }).select("id").single();
    if (orderError) throw orderError;

    const items = Array.isArray(order.items) ? order.items : [];
    const { error: itemError } = await supabase.from("order_items").insert(items.map(item => ({ ...item, order_id: created.id })));
    if (itemError) throw itemError;

    const now = new Date().toISOString();
    const { error: updateError } = await supabase.from("checkout_sessions").update({
      status: "ORDER_CREATED",
      verified_at: verification.verified_at || now,
      order_id: created.id,
      tracking_token: trackingToken,
      telegram_user_id: verification.telegram_user_id || null,
      updated_at: now,
    }).eq("id", session.id);
    if (updateError) throw updateError;

    return { ok: true, orderId: created.id, trackingToken };
  }

  return { create, get, finalizeByVerificationToken };
}
