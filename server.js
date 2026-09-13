import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 3000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "prilavok-backend" });
});


app.post("/api/menu/sync", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || req.body?.deviceKey || "").trim();
    const deviceName = String(req.body?.deviceName || "Прилавок iPad").trim();
    const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
    const products = Array.isArray(req.body?.products) ? req.body.products : [];

    if (!deviceKey) {
      return res.status(401).json({ error: "Missing device key" });
    }

    // Register/update the POS device. The key is generated and stored locally on the iPad.
    const { data: device, error: deviceError } = await supabase
      .from("devices")
      .upsert(
        { device_key: deviceKey, name: deviceName || "Прилавок iPad", is_active: true, last_sync_at: new Date().toISOString() },
        { onConflict: "device_key" }
      )
      .select("id")
      .single();

    if (deviceError) throw deviceError;

    const categoryRows = categories
      .map((c, index) => ({
        external_id: String(c.externalId || `category:${String(c.name || "").trim()}`),
        name: String(c.name || "").trim(),
        color: c.color ? String(c.color) : null,
        sort_order: Number.isFinite(Number(c.sortOrder)) ? Number(c.sortOrder) : index,
        is_active: true
      }))
      .filter(c => c.name && c.external_id);

    if (categoryRows.length) {
      const { error } = await supabase
        .from("categories")
        .upsert(categoryRows, { onConflict: "external_id" });
      if (error) throw error;
    }

    const externalIds = categoryRows.map(c => c.external_id);
    let categoryMap = new Map();

    if (externalIds.length) {
      const { data: dbCategories, error } = await supabase
        .from("categories")
        .select("id,external_id")
        .in("external_id", externalIds);
      if (error) throw error;
      for (const c of dbCategories || []) categoryMap.set(c.external_id, c.id);
    }

    const productRows = products
      .map((p, index) => {
        const categoryName = String(p.category || "Без категории").trim() || "Без категории";
        const categoryExternalId = `category:${categoryName}`;
        return {
          external_id: String(p.externalId || ""),
          name: String(p.name || "").trim(),
          description: p.description ? String(p.description) : null,
          price: Number(p.price || 0),
          category_id: categoryMap.get(categoryExternalId) || null,
          sort_order: Number.isFinite(Number(p.sortOrder)) ? Number(p.sortOrder) : index,
          is_active: p.isActive !== false,
          available_online: p.availableOnline !== false
        };
      })
      .filter(p => p.external_id && p.name);

    if (productRows.length) {
      const { error } = await supabase
        .from("products")
        .upsert(productRows, { onConflict: "external_id" });
      if (error) throw error;
    }

    return res.json({
      ok: true,
      deviceId: device?.id || null,
      categories: categoryRows.length,
      products: productRows.length,
      syncedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("POST /api/menu/sync:", error);
    return res.status(500).json({
      error: "Failed to sync menu"
    });
  }
});

app.get("/api/menu", async (_req, res) => {
  try {
    const { data: categories, error: categoriesError } = await supabase
      .from("categories")
      .select("id,name,color,sort_order,is_active,external_id")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (categoriesError) throw categoriesError;

    const { data: products, error: productsError } = await supabase
      .from("products")
      .select("id,name,description,price,category_id,image_url,sort_order,is_active,available_online,external_id")
      .eq("is_active", true)
      .eq("available_online", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (productsError) throw productsError;

    res.json({
      categories: categories ?? [],
      products: products ?? []
    });
  } catch (error) {
    console.error("GET /api/menu:", error);
    res.status(500).json({
      error: "Failed to load menu"
    });
  }
});



// Connected POS clients receive new web orders over Server-Sent Events (SSE).
// The backend checks Supabase periodically and pushes only orders not yet sent
// to each connected client. This avoids exposing the Supabase service key to the iPad.
const eventClients = new Set();

function writeSse(client, payload) {
  try {
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (_error) {
    eventClients.delete(client);
  }
}

app.get("/api/events/stream", async (req, res) => {
  const deviceKey = String(req.query.deviceKey || "").trim();
  if (!deviceKey) return res.status(401).json({ error: "Missing device key" });

  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select("id,is_active")
    .eq("device_key", deviceKey)
    .maybeSingle();
  if (deviceError) return res.status(500).json({ error: "Failed to validate device" });
  if (!device || !device.is_active) return res.status(401).json({ error: "Invalid device key" });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const client = { res, sent: new Set() };
  eventClients.add(client);
  res.write(`: connected\n\n`);

  const { data: currentOrders } = await supabase
    .from("orders")
    .select("id,external_id,status,order_type,customer_name,phone,address,comment,total,delivery_fee,created_at,updated_at,order_items(*)")
    .eq("status", "new")
    .order("created_at", { ascending: false });
  for (const order of currentOrders || []) {
    client.sent.add(order.id);
    writeSse(client, { type: "order", order: mapOrderForClient(order) });
  }

  const keepAlive = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch (_error) {}
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    eventClients.delete(client);
  });
});

function mapOrderForClient(order) {
  return {
    id: order.id,
    external_id: order.external_id,
    status: order.status,
    order_type: order.order_type,
    customer_name: order.customer_name,
    phone: order.phone,
    address: order.address,
    comment: order.comment,
    total: order.total,
    delivery_fee: order.delivery_fee,
    created_at: order.created_at,
    updated_at: order.updated_at,
    items: (order.order_items || []).map(item => ({
      id: item.id,
      product_id: item.product_id,
      external_product_id: item.external_product_id,
      product_name: item.product_name,
      price: item.price,
      quantity: item.quantity,
      comment: item.comment
    }))
  };
}

async function broadcastNewWebOrders() {
  if (!eventClients.size) return;
  const { data: orders, error } = await supabase
    .from("orders")
    .select("id,external_id,status,order_type,customer_name,phone,address,comment,total,delivery_fee,created_at,updated_at,order_items(*)")
    .eq("status", "new")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("Web order event poll:", error);
    return;
  }
  for (const client of eventClients) {
    for (const order of orders || []) {
      if (client.sent.has(order.id)) continue;
      client.sent.add(order.id);
      writeSse(client, { type: "order", order: mapOrderForClient(order) });
    }
  }
}

setInterval(broadcastNewWebOrders, 2000);

// Public web menu creates an order without customer registration.
app.post("/api/orders", async (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res.status(400).json({ error: "Order must contain items" });

    const externalId = String(body.externalId || `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const rows = items.map(item => ({
      product_id: item.productId || null,
      external_product_id: item.externalProductId || item.productId || null,
      product_name: String(item.productName || item.name || "Товар"),
      price: Number(item.price || 0),
      quantity: Number(item.quantity || item.qty || 1),
      comment: item.comment ? String(item.comment) : null
    })).filter(item => item.quantity > 0 && item.product_name);
    if (!rows.length) return res.status(400).json({ error: "Invalid order items" });

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        external_id: externalId,
        status: "new",
        order_type: body.orderType ? String(body.orderType) : "На месте",
        customer_name: body.customerName ? String(body.customerName) : null,
        phone: body.phone ? String(body.phone) : null,
        address: body.address ? String(body.address) : null,
        comment: body.comment ? String(body.comment) : null,
        total: Number(body.total || 0),
        delivery_fee: Number(body.deliveryFee || 0)
      })
      .select("id,external_id,status,order_type,customer_name,phone,address,comment,total,delivery_fee,created_at,updated_at")
      .single();
    if (orderError) throw orderError;

    const { error: itemsError } = await supabase
      .from("order_items")
      .insert(rows.map(row => ({ ...row, order_id: order.id })));
    if (itemsError) throw itemsError;

    const fullOrder = { ...order, order_items: rows.map(row => ({ ...row, order_id: order.id })) };
    for (const client of eventClients) {
      if (!client.sent.has(order.id)) {
        client.sent.add(order.id);
        writeSse(client, { type: "order", order: mapOrderForClient(fullOrder) });
      }
    }

    return res.status(201).json({ ok: true, order: mapOrderForClient(fullOrder) });
  } catch (error) {
    console.error("POST /api/orders:", error);
    return res.status(500).json({ error: "Failed to create order" });
  }
});

app.post("/api/orders/:id/status", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || "").trim();
    const status = String(req.body?.status || "").trim();
    const allowed = new Set(["accepted", "cancelled", "completed"]);
    if (!deviceKey || !allowed.has(status)) return res.status(400).json({ error: "Invalid request" });

    const { data: device, error: deviceError } = await supabase
      .from("devices")
      .select("id,is_active")
      .eq("device_key", deviceKey)
      .maybeSingle();
    if (deviceError) throw deviceError;
    if (!device || !device.is_active) return res.status(401).json({ error: "Invalid device key" });

    const { data, error } = await supabase
      .from("orders")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select("id,status,updated_at")
      .single();
    if (error) throw error;
    return res.json({ ok: true, order: data });
  } catch (error) {
    console.error("POST /api/orders/:id/status:", error);
    return res.status(500).json({ error: "Failed to update order status" });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Prilavok backend listening on port ${port}`);
});
