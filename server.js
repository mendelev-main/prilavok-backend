import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

import "./public/order-validation.js";
const { validate: validateOrderContact, normalizePhone } = globalThis.OrderValidation;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const port = process.env.PORT || 3000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const deliveryFee = Number(process.env.DELIVERY_FEE || 0);

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "prilavok-backend" });
});

app.post("/api/media/upload", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || req.body?.deviceKey || "").trim();
    const productId = String(req.body?.productId || "").trim();
    const dataUrl = String(req.body?.dataUrl || "").trim();
    if (!deviceKey || !productId || !dataUrl) return res.status(400).json({ error: "Missing upload data" });

    const { data: device, error: deviceError } = await supabase
      .from("devices").select("id").eq("device_key", deviceKey).eq("is_active", true).maybeSingle();
    if (deviceError) throw deviceError;
    if (!device) return res.status(401).json({ error: "Invalid device key" });

    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i);
    if (!match) return res.status(400).json({ error: "Only JPEG, PNG or WebP images are supported" });
    const mime = match[1].toLowerCase();
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 1500000) return res.status(400).json({ error: "Image is too large" });

    const bucket = "product-images";
    const createBucket = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, "Content-Type": "application/json" },
      body: JSON.stringify({ id: bucket, name: bucket, public: true })
    });
    if (!createBucket.ok) {
      const txt = await createBucket.text();
      let duplicate = createBucket.status === 409;
      try {
        const body = JSON.parse(txt);
        duplicate = duplicate || body?.code === "BucketAlreadyExists" || Number(body?.statusCode) === 409;
      } catch (_) {}
      if (!duplicate) throw new Error(`Storage bucket: ${createBucket.status} ${txt}`);
    }

    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const path = `products/${encodeURIComponent(productId)}.${ext}`;
    const upload = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, "Content-Type": mime, "x-upsert": "true" },
      body: buffer
    });
    if (!upload.ok) {
      const txt = await upload.text();
      throw new Error(`Storage upload: ${upload.status} ${txt}`);
    }
    const url = `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
    return res.json({ ok: true, url });
  } catch (error) {
    console.error("POST /api/media/upload:", error);
    return res.status(500).json({ error: "Failed to upload image" });
  }
});

app.post("/api/menu/sync", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || req.body?.deviceKey || "").trim();
    const deviceName = String(req.body?.deviceName || "Прилавок iPad").trim();
    const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
    const products = Array.isArray(req.body?.products) ? req.body.products : [];
    if (!deviceKey) return res.status(401).json({ error: "Missing device key" });

    const { data: device, error: deviceError } = await supabase
      .from("devices")
      .upsert(
        { device_key: deviceKey, name: deviceName || "Прилавок iPad", is_active: true, last_sync_at: new Date().toISOString() },
        { onConflict: "device_key" }
      ).select("id").single();
    if (deviceError) throw deviceError;

    const categoryRows = categories.map((c, index) => ({
      external_id: String(c.externalId || `category:${String(c.name || "").trim()}`),
      name: String(c.name || "").trim(),
      color: c.color ? String(c.color) : null,
      sort_order: Number.isFinite(Number(c.sortOrder)) ? Number(c.sortOrder) : index,
      is_active: c.isActive !== false
    })).filter(c => c.name && c.external_id);

    if (categoryRows.length) {
      const { error } = await supabase.from("categories").upsert(categoryRows, { onConflict: "external_id" });
      if (error) throw error;
    }

    const { data: existingCategories, error: existingCategoriesError } = await supabase.from("categories").select("id,external_id");
    if (existingCategoriesError) throw existingCategoriesError;
    const externalIds = categoryRows.map(c => c.external_id);
    const categoryExternalIdSet = new Set(externalIds);
    const staleCategoryIds = (existingCategories || []).filter(c => c.external_id && !categoryExternalIdSet.has(c.external_id)).map(c => c.id);
    if (staleCategoryIds.length) {
      const { error } = await supabase.from("categories").update({ is_active: false }).in("id", staleCategoryIds);
      if (error) throw error;
    }

    const categoryMap = new Map();
    if (externalIds.length) {
      const { data: dbCategories, error } = await supabase.from("categories").select("id,external_id").in("external_id", externalIds);
      if (error) throw error;
      for (const c of dbCategories || []) categoryMap.set(c.external_id, c.id);
    }

    const productRows = products.map((p, index) => {
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
        available_online: p.availableOnline !== false,
        image_url: p.imageUrl ? String(p.imageUrl) : null
      };
    }).filter(p => p.external_id && p.name);

    if (productRows.length) {
      const { error } = await supabase.from("products").upsert(productRows, { onConflict: "external_id" });
      if (error) throw error;
    }

    const { data: existingProducts, error: existingProductsError } = await supabase.from("products").select("id,external_id");
    if (existingProductsError) throw existingProductsError;
    const productExternalIdSet = new Set(productRows.map(p => p.external_id));
    const staleProductIds = (existingProducts || []).filter(p => p.external_id && !productExternalIdSet.has(p.external_id)).map(p => p.id);
    if (staleProductIds.length) {
      const { error } = await supabase.from("products").update({ is_active: false, available_online: false }).in("id", staleProductIds);
      if (error) throw error;
    }

    return res.json({ ok: true, deviceId: device?.id || null, categories: categoryRows.length, products: productRows.length, syncedAt: new Date().toISOString() });
  } catch (error) {
    console.error("POST /api/menu/sync:", error);
    return res.status(500).json({ error: "Failed to sync menu" });
  }
});

app.get("/api/menu", async (_req, res) => {
  try {
    const { data: categories, error: categoriesError } = await supabase.from("categories").select("id,name,color,sort_order,is_active,external_id").eq("is_active", true).order("sort_order", { ascending: true }).order("name", { ascending: true });
    if (categoriesError) throw categoriesError;
    const { data: products, error: productsError } = await supabase.from("products").select("id,name,description,price,category_id,image_url,sort_order,is_active,available_online,external_id").eq("is_active", true).eq("available_online", true).order("sort_order", { ascending: true }).order("name", { ascending: true });
    if (productsError) throw productsError;
    const onlineCategoryIds = new Set((products ?? []).map(p => p.category_id).filter(Boolean));
    const visibleCategories = (categories ?? []).filter(c => onlineCategoryIds.has(c.id));
    res.json({ categories: visibleCategories, products: products ?? [] });
  } catch (error) {
    console.error("GET /api/menu:", error);
    res.status(500).json({ error: "Failed to load menu" });
  }
});

const eventClients = new Set();
let eventPollBusy = false;
async function pushNewOrders(){
  if(eventPollBusy || !eventClients.size) return;
  eventPollBusy = true;
  try{
    const { data, error } = await supabase.from("orders").select("id,external_id,status,order_type,customer_name,phone,address,comment,total,delivery_fee,created_at,updated_at,order_items(id,product_id,external_product_id,product_name,price,quantity,comment)").eq("status", "new").order("created_at", { ascending: false }).limit(20);
    if(error) throw error;
    const payload = JSON.stringify({type:"orders",orders:data||[]});
    for(const client of eventClients){ try { client.res.write(`data: ${payload}\n\n`); } catch(e) {} }
  } catch(error){ console.error("order event poll:", error); }
  finally { eventPollBusy = false; }
}
setInterval(pushNewOrders, 2000);

app.get("/api/orders/events", async (req, res) => {
  const deviceKey = String(req.header("x-device-key") || req.query.deviceKey || "").trim();
  if(!deviceKey) return res.status(401).json({error:"Missing device key"});
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const client={res,deviceKey}; eventClients.add(client);
  res.write(`event: ready\ndata: ${JSON.stringify({ok:true})}\n\n`);
  const heartbeat=setInterval(()=>{ try{res.write(`: ping\n\n`);}catch(e){} }, 15000);
  req.on("close",()=>{clearInterval(heartbeat);eventClients.delete(client);});
  pushNewOrders();
});

app.get("/api/config", (_req, res) => {
  res.json({ deliveryFee: Number.isFinite(deliveryFee) ? deliveryFee : 0 });
});

app.post("/api/orders", async (req, res) => {
  try {
    const orderType = String(req.body?.orderType || "Самовывоз").trim();
    const customerName = String(req.body?.customerName || "").trim();
    const rawPhone = String(req.body?.phone || "").trim();
    const phone = normalizePhone(rawPhone);
    const address = String(req.body?.address || "").trim();
    const comment = String(req.body?.comment || "").trim();
    const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!customerName || !phone || !requestedItems.length) return res.status(400).json({ error: "Заполните данные заказа и добавьте товары" });
    if (orderType === "Доставка" && !address) return res.status(400).json({ error: "Укажите адрес доставки" });

    const contactError = validateOrderContact({ phone: rawPhone, comment, items: requestedItems });
    if (contactError) return res.status(400).json({ error: contactError });

    const ids = requestedItems.map(x => String(x.productId || "").trim()).filter(Boolean);
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length || uniqueIds.length !== ids.length) return res.status(400).json({ error: "Некорректные товары в заказе" });

    const { data: products, error: productsError } = await supabase.from("products").select("id,external_id,name,price").in("id", uniqueIds).eq("is_active", true).eq("available_online", true);
    if (productsError) throw productsError;
    const productMap = new Map((products || []).map(p => [p.id, p]));
    if (productMap.size !== uniqueIds.length) return res.status(400).json({ error: "Один из товаров больше недоступен для заказа" });

    const items = [];
    let subtotal = 0;
    for (const raw of requestedItems) {
      const product = productMap.get(String(raw.productId));
      const quantity = Number(raw.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 99) return res.status(400).json({ error: "Некорректное количество товара" });
      const lineTotal = Number(product.price || 0) * quantity;
      subtotal += lineTotal;
      items.push({ product_id: product.id, external_product_id: product.external_id, product_name: product.name, price: Number(product.price || 0), quantity, comment: raw.comment ? String(raw.comment).trim().slice(0, 500) : null });
    }

    const fee = orderType === "Доставка" ? (Number.isFinite(deliveryFee) ? deliveryFee : 0) : 0;
    const total = subtotal + fee;
    const externalId = `WEB-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const trackingToken = randomUUID().replace(/-/g, "");

    const { data: order, error: orderError } = await supabase.from("orders").insert({ external_id: externalId, tracking_token: trackingToken, status: "new", order_type: orderType, customer_name: customerName, phone, address: orderType === "Доставка" ? address : null, comment: comment || null, total, delivery_fee: fee }).select("*").single();
    if (orderError) throw orderError;

    const rows = items.map(item => ({ ...item, order_id: order.id }));
    const { error: itemError } = await supabase.from("order_items").insert(rows);
    if (itemError) throw itemError;

    res.status(201).json({ ok: true, orderId: order.id, externalId, trackingToken, total, deliveryFee: fee });
  } catch (error) {
    console.error("POST /api/orders:", error);
    res.status(500).json({ error: "Не удалось создать заказ" });
  }
});

app.get("/api/orders/track/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token || token.length < 20) return res.status(400).json({ error: "Некорректный код заказа" });
    const { data: order, error } = await supabase.from("orders").select("id,external_id,status,order_type,customer_name,total,delivery_fee,created_at,updated_at,order_items(id,product_name,price,quantity,comment)").eq("tracking_token", token).maybeSingle();
    if (error) throw error;
    if (!order) return res.status(404).json({ error: "Заказ не найден" });
    res.json({ ok: true, order });
  } catch (error) {
    console.error("GET /api/orders/track/:token:", error);
    res.status(500).json({ error: "Не удалось получить заказ" });
  }
});

app.post("/api/orders/test", async (req,res)=>{
  try{
    const deviceKey=String(req.header("x-device-key")||req.body?.deviceKey||"").trim();
    if(!deviceKey) return res.status(401).json({error:"Missing device key"});
    const {data:device,error:deviceError}=await supabase.from("devices").select("id").eq("device_key",deviceKey).eq("is_active",true).maybeSingle();
    if(deviceError) throw deviceError;
    if(!device) return res.status(403).json({error:"Unknown device"});
    const {data:product,error:productError}=await supabase.from("products").select("id,external_id,name,price").eq("is_active",true).eq("available_online",true).order("sort_order").limit(1).maybeSingle();
    if(productError) throw productError;
    if(!product) return res.status(400).json({error:"No online products. Sync the menu first."});
    const qty=1;
    const total=Number(product.price||0)+5;
    const trackingToken=randomUUID().replace(/-/g,"");
    const {data:order,error:orderError}=await supabase.from("orders").insert({external_id:`TEST-${Date.now()}`,tracking_token:trackingToken,status:"new",order_type:"Доставка",customer_name:"Тестовый клиент",phone:"+375 29 000-00-00",address:"Тестовый адрес, 1",comment:"Тестовый веб-заказ",total,delivery_fee:5}).select("*").single();
    if(orderError) throw orderError;
    const {error:itemError}=await supabase.from("order_items").insert({order_id:order.id,product_id:product.id,external_product_id:product.external_id,product_name:product.name,price:Number(product.price||0),quantity:qty,comment:null});
    if(itemError) throw itemError;
    res.json({ok:true,orderId:order.id,externalId:order.external_id,trackingToken});
  } catch(error){ console.error("POST /api/orders/test:",error); res.status(500).json({error:"Failed to create test order"}); }
});

app.post("/api/orders/:id/accept", async (req,res)=>{
  try{
    const deviceKey=String(req.header("x-device-key")||req.body?.deviceKey||"").trim();
    if(!deviceKey) return res.status(401).json({error:"Missing device key"});
    const {data:device}=await supabase.from("devices").select("id").eq("device_key",deviceKey).eq("is_active",true).maybeSingle();
    if(!device) return res.status(403).json({error:"Unknown device"});
    const {data:order,error}=await supabase.from("orders").update({status:"accepted",updated_at:new Date().toISOString()}).eq("id",req.params.id).eq("status","new").select("id,status,updated_at").maybeSingle();
    if(error) throw error;
    if(!order) return res.status(409).json({error:"Order is no longer new"});
    res.json({ok:true,order});
  } catch(error){ console.error("POST /api/orders/:id/accept:",error); res.status(500).json({error:"Failed to accept order"}); }
});

app.use((_req, res) => { res.status(404).json({ error: "Not found" }); });
app.listen(port, "0.0.0.0", () => { console.log(`Prilavok backend listening on port ${port}`); });
