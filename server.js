import express from "express";
import { mountOwnerRoutes, ownerBotAuthorized } from "./owner-auth.js";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { createPhoneVerificationService } from "./phone-verification.js";
import { createCheckoutService } from "./checkout-service.js";
import { createAvailabilityService } from "./availability-service.js";
import { calculateLoyaltyTransition, formatLoyaltySaleMessage, loyaltyIdempotencyKey } from "./loyalty-engine.js";
import { validateLoyaltyAllocation } from "./loyalty-allocation.js";
import { closedPageHtml, isOrderingOpen, isSiteSleepWindow, millisecondsUntilSiteWake, VENUE_TIME_ZONE } from "./business-hours.js";
import { createTelegramOrderAlerts } from "./telegram-order-alerts.js";
import { createLivePosReports } from "./live-pos-reports.js";

import "./public/order-validation.js";
const { validate: validateOrderContact, normalizePhone } = globalThis.OrderValidation;

const app = express();
app.use(cors());
app.use("/api/owner/report", express.json({ limit: "14mb" }));
app.use(express.json({ limit: "2mb" }));
app.use((req,res,next)=>{
  if(req.method==="GET"&&req.path==="/"&&!isSiteSleepWindow()&&!isOrderingOpen()){
    res.setHeader("Cache-Control","no-store");
    return res.type("html").send(closedPageHtml({ordering:true}));
  }
  next();
});
app.use((req,res,next)=>{
  if(!isSiteSleepWindow())return next();
  const retrySeconds=Math.ceil(millisecondsUntilSiteWake()/1000),path=String(req.path||"");
  if(req.method==="GET"&&(path==="/"||path==="/menu"||path==="/menu/")){res.setHeader("Cache-Control","no-store");res.setHeader("Retry-After",String(retrySeconds));return res.status(503).type("html").send(closedPageHtml())}
  if(req.method==="GET"&&(path==="/api/menu"||path==="/api/menu/availability")){res.setHeader("Cache-Control","no-store");res.setHeader("Retry-After",String(retrySeconds));return res.status(503).json({error:"Сайт доступен с 06:00",opensAt:"06:00",timeZone:VENUE_TIME_ZONE})}
  return next();
});
app.use(express.static("public",{setHeaders(res,filePath){
  if(filePath.endsWith(".html"))res.setHeader("Cache-Control","no-cache");
  else res.setHeader("Cache-Control","public, max-age=3600, stale-while-revalidate=86400");
}}));

const port = process.env.PORT || 3000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const deliveryFee = Number(process.env.DELIVERY_FEE || 0);
const siteSleepingNow=()=>typeof isSiteSleepWindow==="function"&&isSiteSleepWindow();
const orderingOpenNow=()=>typeof isOrderingOpen!=="function"||isOrderingOpen();

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const newRevisionId=()=>typeof randomUUID==="function"?randomUUID().slice(0,8):"test";
let catalogRevision=`boot-${Date.now().toString(36)}-${newRevisionId()}`;
function advanceCatalogRevision(){catalogRevision=`sync-${Date.now().toString(36)}-${newRevisionId()}`;return catalogRevision}
mountOwnerRoutes(app,{db:supabase});
const phoneVerification = createPhoneVerificationService(supabase, normalizePhone);
const availability = createAvailabilityService({supabase});
const checkout = createCheckoutService({ supabase, normalizePhone, validateOrderContact, phoneVerification, availability, deliveryFee });
const telegramOrderAlerts = createTelegramOrderAlerts({ supabase, botToken: process.env.TELEGRAM_BOT_TOKEN });
const livePosReports = createLivePosReports({ supabase, createId: () => randomUUID() });

function missingOnlineMenuColumn(error) {
  const message = String(error?.message || error?.details || "").toLowerCase();
  return ["42703", "PGRST204"].includes(String(error?.code || "")) && message.includes("visible_in_menu");
}

function withoutOnlineMenuColumn(rows) {
  return rows.map(({ visible_in_menu: _visibleInMenu, ...row }) => row);
}

function missingCategoryChannelColumn(error) {
  const message = String(error?.message || error?.details || "").toLowerCase();
  return ["42703", "PGRST204"].includes(String(error?.code || ""))
    && (message.includes("available_online") || message.includes("visible_in_menu"));
}

function withoutCategoryChannelColumns(rows) {
  return rows.map(({ available_online: _availableOnline, visible_in_menu: _visibleInMenu, ...row }) => row);
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "prilavok-backend" }));

app.post("/api/checkout", async (req, res) => {
  try {
    if(!orderingOpenNow())return res.status(503).json({error:"Онлайн-заказы принимаются с 10:00 до 22:30",opensAt:"10:00",closesAt:"22:30",timeZone:VENUE_TIME_ZONE});
    const result = await checkout.create(req.body);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    return res.status(201).json(result);
  } catch (error) {
    console.error("POST /api/checkout:", error);
    return res.status(500).json({ error: "Не удалось начать оформление заказа" });
  }
});

app.get("/api/checkout/:token", async (req, res) => {
  try {
    const session = await checkout.get(String(req.params.token || ""));
    if (!session) return res.status(404).json({ error: "Оформление не найдено" });
    return res.json({ status: session.status, expiresAt: session.expires_at, orderId: session.order_id || null });
  } catch (error) {
    console.error("GET /api/checkout/:token:", error);
    return res.status(500).json({ error: "Не удалось проверить оформление" });
  }
});

app.post("/api/phone-verification", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").trim();
    const returnUrl = req.body?.returnUrl ? String(req.body.returnUrl).trim() : null;
    const result = await phoneVerification.create(phone, returnUrl);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    return res.status(201).json(result);
  } catch (error) {
    console.error("POST /api/phone-verification:", error);
    return res.status(500).json({ error: "Не удалось начать подтверждение номера" });
  }
});

app.get("/api/phone-verification/:token", async (req, res) => {
  try {
    const verification = await phoneVerification.get(req.params.token);
    if (!verification) return res.status(404).json({ error: "Подтверждение не найдено" });
    return res.json({ status: verification.status, phone: verification.phone, expiresAt: verification.expires_at, verifiedAt: verification.verified_at });
  } catch (error) {
    console.error("GET /api/phone-verification/:token:", error);
    return res.status(500).json({ error: "Не удалось проверить статус" });
  }
});

app.post("/api/phone-verification/:token/confirm", async (req, res) => {
  if (!ownerBotAuthorized(req.header("x-owner-bot-secret"), process.env.OWNER_BOT_SHARED_SECRET)) {
    return res.status(403).json({ ok: false, error: "Подтверждение доступно только через бота" });
  }
  try {
    const phone = String(req.body?.phone || "").trim();
    const telegramUserId = req.body?.telegramUserId;
    const result = await phoneVerification.confirm(req.params.token, phone, telegramUserId, ownerBotAuthorized(req.header("x-owner-bot-secret"), process.env.OWNER_BOT_SHARED_SECRET) ? req.body?.telegramUsername : undefined);
    if (!result.ok) return res.status(409).json(result);

    const finalized = await checkout.finalizeByVerificationToken(req.params.token);
    if (finalized && !finalized.ok) {
      const stockError=finalized.reason==="OUT_OF_STOCK"?"Товар закончился или его осталось недостаточно":finalized.reason==="AVAILABILITY_UNAVAILABLE"?"Актуальные остатки временно недоступны":"Не удалось завершить оформление заказа";
      return res.status(409).json({ ok: false, error: stockError, reason: finalized.reason });
    }
    if (finalized?.ok && finalized.duplicate !== true) {
      void telegramOrderAlerts.notifyNewOrder().catch(error => console.error("Telegram POS order alert:", error));
    }
    return res.json({ ...result, orderCreated: Boolean(finalized?.ok) });
  } catch (error) {
    console.error("POST /api/phone-verification/:token/confirm:", error);
    return res.status(500).json({ ok: false, error: "Не удалось подтвердить номер" });
  }
});

app.post("/api/media/upload", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || req.body?.deviceKey || "").trim();
    const productId = String(req.body?.productId || "").trim();
    const dataUrl = String(req.body?.dataUrl || "").trim();
    if (!deviceKey || !productId || !dataUrl) return res.status(400).json({ error: "Missing upload data" });
    const { data: device, error: deviceError } = await supabase.from("devices").select("id").eq("device_key", deviceKey).eq("is_active", true).maybeSingle();
    if (deviceError) throw deviceError;
    if (!device) return res.status(401).json({ error: "Invalid device key" });
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i);
    if (!match) return res.status(400).json({ error: "Only JPEG, PNG or WebP images are supported" });
    const mime = match[1].toLowerCase();
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 1500000) return res.status(400).json({ error: "Image is too large" });
    const bucket = "product-images";
    const createBucket = await fetch(`${supabaseUrl}/storage/v1/bucket`, { method: "POST", headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, "Content-Type": "application/json" }, body: JSON.stringify({ id: bucket, name: bucket, public: true }) });
    if (!createBucket.ok) {
      const txt = await createBucket.text(); let duplicate = createBucket.status === 409;
      try { const body = JSON.parse(txt); duplicate = duplicate || body?.code === "BucketAlreadyExists" || Number(body?.statusCode) === 409; } catch (_) {}
      if (!duplicate) throw new Error(`Storage bucket: ${createBucket.status} ${txt}`);
    }
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const path = `products/${encodeURIComponent(productId)}.${ext}`;
    const upload = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, "Content-Type": mime, "cache-control": "max-age=604800", "x-upsert": "true" }, body: buffer });
    if (!upload.ok) throw new Error(`Storage upload: ${upload.status} ${await upload.text()}`);
    const imageVersion=createHash("sha256").update(buffer).digest("hex").slice(0,16);
    return res.json({ ok: true, url: `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}?v=${imageVersion}` });
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
    const { data: device, error: deviceError } = await supabase.from("devices").upsert({ device_key: deviceKey, name: deviceName || "Прилавок iPad", is_active: true, last_sync_at: new Date().toISOString() }, { onConflict: "device_key" }).select("id").single();
    if (deviceError) throw deviceError;
    const categoryRows = categories.map((c, index) => ({ external_id: String(c.externalId || `category:${String(c.name || "").trim()}`), name: String(c.name || "").trim(), color: c.color ? String(c.color) : null, sort_order: Number.isFinite(Number(c.sortOrder)) ? Number(c.sortOrder) : index, is_active: c.isActive !== false, available_online: c.availableOnline !== false, visible_in_menu: c.visibleInOnlineMenu !== false })).filter(c => c.name && c.external_id);
    if (categoryRows.length) {
      let { error } = await supabase.from("categories").upsert(categoryRows, { onConflict: "external_id" });
      if (missingCategoryChannelColumn(error)) ({ error } = await supabase.from("categories").upsert(withoutCategoryChannelColumns(categoryRows), { onConflict: "external_id" }));
      if (error) throw error;
    }
    const { data: existingCategories, error: existingCategoriesError } = await supabase.from("categories").select("id,external_id");
    if (existingCategoriesError) throw existingCategoriesError;
    const externalIds = categoryRows.map(c => c.external_id); const categoryExternalIdSet = new Set(externalIds);
    const staleCategoryIds = (existingCategories || []).filter(c => c.external_id && !categoryExternalIdSet.has(c.external_id)).map(c => c.id);
    if (staleCategoryIds.length) { const { error } = await supabase.from("categories").update({ is_active: false }).in("id", staleCategoryIds); if (error) throw error; }
    const categoryMap = new Map();
    if (externalIds.length) { const { data: dbCategories, error } = await supabase.from("categories").select("id,external_id").in("external_id", externalIds); if (error) throw error; for (const c of dbCategories || []) categoryMap.set(c.external_id, c.id); }
    const productRows = products.map((p, index) => { const categoryName = String(p.category || "Без категории").trim() || "Без категории"; return { external_id: String(p.externalId || ""), name: String(p.name || "").trim(), description: p.description ? String(p.description) : null, price: Number(p.price || 0), category_id: categoryMap.get(`category:${categoryName}`) || null, sort_order: Number.isFinite(Number(p.sortOrder)) ? Number(p.sortOrder) : index, is_active: p.isActive !== false, available_online: p.availableOnline !== false, visible_in_menu: p.visibleInOnlineMenu !== false, image_url: p.imageUrl ? String(p.imageUrl) : null }; }).filter(p => p.external_id && p.name);
    if (productRows.length) {
      let { error } = await supabase.from("products").upsert(productRows, { onConflict: "external_id" });
      if (missingOnlineMenuColumn(error)) ({ error } = await supabase.from("products").upsert(withoutOnlineMenuColumn(productRows), { onConflict: "external_id" }));
      if (error) throw error;
    }
    const { data: existingProducts, error: existingProductsError } = await supabase.from("products").select("id,external_id");
    if (existingProductsError) throw existingProductsError;
    const productExternalIdSet = new Set(productRows.map(p => p.external_id));
    const staleProductIds = (existingProducts || []).filter(p => p.external_id && !productExternalIdSet.has(p.external_id)).map(p => p.id);
    if (staleProductIds.length) { const { error } = await supabase.from("products").update({ is_active: false, available_online: false }).in("id", staleProductIds); if (error) throw error; }
    const revision=advanceCatalogRevision();
    return res.json({ ok: true, deviceId: device?.id || null, categories: categoryRows.length, products: productRows.length, syncedAt: new Date().toISOString(),catalogRevision:revision });
  } catch (error) { console.error("POST /api/menu/sync:", error); return res.status(500).json({ error: "Failed to sync menu" }); }
});

app.post("/api/availability/snapshot",async(req,res)=>{
  try{
    const result=await availability.store(req.header("x-device-key")||req.body?.deviceKey,req.body);
    if(result.error)return res.status(result.status||400).json({error:result.error});
    return res.json(result);
  }catch(error){console.error("POST /api/availability/snapshot:",error);return res.status(500).json({error:"Failed to store availability snapshot"})}
});


const OPERATIONAL_SCHEMA_VERSION = 1;
const OPERATIONAL_FRESH_MS = Number(process.env.OPERATIONAL_FRESH_MS || 45000);
async function operationalDevice(req) {
  const deviceKey = String(req.header("x-device-key") || "").trim();
  if (!deviceKey) return { error: "Missing device key", status: 401 };
  const { data: device, error } = await supabase.from("devices").select("id,device_key,name,is_active").eq("device_key", deviceKey).eq("is_active", true).maybeSingle();
  if (error) throw error;
  if (!device) return { error: "Invalid device key", status: 401 };
  return { device };
}
function validateOperationalVersion(body) {
  return Number(body?.schemaVersion) === OPERATIONAL_SCHEMA_VERSION;
}
app.post("/api/operational/heartbeat", async (req, res) => {
  try {
    const auth = await operationalDevice(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (!validateOperationalVersion(req.body)) return res.status(409).json({ error: "Unsupported operational schema version", expected: OPERATIONAL_SCHEMA_VERSION });
    const receivedAt = new Date().toISOString();
    const sampledAt = new Date(req.body?.sampledAt || receivedAt);
    if (Number.isNaN(sampledAt.getTime())) return res.status(400).json({ error: "Invalid sampledAt" });
    const row = { device_id: auth.device.id, schema_version: OPERATIONAL_SCHEMA_VERSION, engine_version: null, heartbeat_at: receivedAt, updated_at: receivedAt };
    const { error } = await supabase.from("operational_states").upsert(row, { onConflict: "device_id" });
    if (error) throw error;
    return res.json({ ok: true, receivedAt });
  } catch (error) {
    console.error("POST /api/operational/heartbeat:", error);
    return res.status(500).json({ error: "Failed to store operational heartbeat" });
  }
});
app.post("/api/operational/snapshot", async (req, res) => {
  try {
    const auth = await operationalDevice(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (!validateOperationalVersion(req.body)) return res.status(409).json({ error: "Unsupported operational schema version", expected: OPERATIONAL_SCHEMA_VERSION });
    if (!req.body?.demand || typeof req.body.demand !== "object" || typeof req.body.demand.overload !== "boolean") return res.status(400).json({ error: "Missing demand snapshot" });
    const receivedAt = new Date().toISOString(),sampledAt = new Date(req.body?.sampledAt || receivedAt),revision=Number(req.body?.revision);
    if (Number.isNaN(sampledAt.getTime())) return res.status(400).json({ error: "Invalid sampledAt" });
    if (!Number.isSafeInteger(revision) || revision <= 0) return res.status(400).json({ error: "Invalid snapshot revision" });
    const { data: applied, error } = await supabase.rpc("store_operational_snapshot",{p_device_id:auth.device.id,p_schema_version:OPERATIONAL_SCHEMA_VERSION,p_engine_version:null,p_revision:revision,p_sampled_at:sampledAt.toISOString(),p_received_at:receivedAt,p_snapshot:req.body});
    if (error) throw error;
    return res.json({ ok: true, applied: applied===true, ignoredAsStale: applied!==true, revision, receivedAt });
  } catch (error) {
    console.error("POST /api/operational/snapshot:", error);
    return res.status(500).json({ error: "Failed to store operational snapshot" });
  }
});
app.get("/api/operational/state", async (req, res) => {
  try {
    const auth = await operationalDevice(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    const { data, error } = await supabase.from("operational_states").select("schema_version,heartbeat_at,snapshot_sampled_at,snapshot_received_at,snapshot_revision,snapshot,updated_at").eq("device_id", auth.device.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.json({ available: false, fresh: false, reason: "missing", freshnessMs: null, state: null });
    const now=Date.now(),heartbeatAt=data.heartbeat_at?new Date(data.heartbeat_at).getTime():0,sampledAt=data.snapshot_sampled_at?new Date(data.snapshot_sampled_at).getTime():0,receivedAt=data.snapshot_received_at?new Date(data.snapshot_received_at).getTime():0;
    const freshnessMs=heartbeatAt?Math.max(0,now-heartbeatAt):null,snapshotAgeMs=sampledAt?now-sampledAt:null,snapshotReceivedAgeMs=receivedAt?Math.max(0,now-receivedAt):null;
    const compatible=Number(data.schema_version)===OPERATIONAL_SCHEMA_VERSION&&Number(data.snapshot?.schemaVersion)===OPERATIONAL_SCHEMA_VERSION&&typeof data.snapshot?.demand?.overload==='boolean';
    const clockValid=snapshotAgeMs!==null&&snapshotAgeMs>=-30000;
    const fresh=compatible&&!!data.snapshot&&freshnessMs!==null&&freshnessMs<=OPERATIONAL_FRESH_MS&&clockValid&&snapshotAgeMs<=OPERATIONAL_FRESH_MS&&snapshotReceivedAgeMs!==null&&snapshotReceivedAgeMs<=OPERATIONAL_FRESH_MS;
    const reason=!compatible?"incompatible":!data.snapshot?"missing_snapshot":!clockValid?"invalid_snapshot_clock":!fresh?"stale":null;
    return res.json({available:fresh,fresh,compatible,reason,freshnessMs,snapshotAgeMs,snapshotReceivedAgeMs,maxFreshnessMs:OPERATIONAL_FRESH_MS,state:fresh?data.snapshot:null});
  } catch (error) {
    console.error("GET /api/operational/state:", error);
    return res.status(500).json({ error: "Failed to read operational state" });
  }
});


const DEMAND_STATUS_VALID_FOR_SECONDS = 45;
async function latestStoredDemandState() {
  const { data: devices, error: deviceError } = await supabase.from("devices").select("id").eq("is_active", true);
  if (deviceError) throw deviceError;
  const ids = (devices || []).map(x=>x.id);
  if (!ids.length) return { available:false, reason:"missing" };
  // v1 has one location/POS identity. Never guess between multiple active devices.
  if (ids.length !== 1) return { available:false, reason:"ambiguous_location" };
  const { data: rows, error } = await supabase
    .from("operational_states")
    .select("device_id,schema_version,snapshot_received_at,snapshot")
    .in("device_id", ids)
    .order("snapshot_received_at",{ascending:false})
    .limit(10);
  if (error) throw error;
  for (const row of (rows || [])) {
    const compatible = Number(row.schema_version) === OPERATIONAL_SCHEMA_VERSION
      && Number(row.snapshot?.schemaVersion) === OPERATIONAL_SCHEMA_VERSION
      && typeof row.snapshot?.demand?.overload === "boolean";
    if (compatible) return { available:true, state:row.snapshot, storedAt:row.snapshot_received_at || null };
  }
  return { available:false, reason:(rows || []).length ? "incompatible" : "missing" };
}

async function demandStatusResponse(res) {
  try {
    const stateResult=await latestStoredDemandState();
    if (!stateResult.available) return res.json({available:false,demandState:"UNAVAILABLE"});
    const overload=stateResult.state?.demand?.overload===true;
    return res.json({
      available:true,
      demandState:overload?"OVERLOAD":"NORMAL",
      overload,
      storedAt:stateResult.storedAt,
      calculatedAt:new Date().toISOString(),
      validForSeconds:DEMAND_STATUS_VALID_FOR_SECONDS
    });
  } catch(error) {
    console.error("Demand status:",error);
    return res.json({available:false,demandState:"UNAVAILABLE"});
  }
}

app.get("/api/demand/status", async (_req,res) => demandStatusResponse(res));
// Temporary compatibility route for already cached/older web clients. It performs no ETA calculation.
app.post("/api/eta/estimate", async (_req,res) => demandStatusResponse(res));

app.get("/api/menu/availability",async(_req,res)=>{
  try{
    const items=(await availability.list()).map(row=>({external_id:row.externalId,availability_known:true,available_quantity:row.quantity}));
    res.setHeader?.("Cache-Control","no-store");
    return res.json({catalog_revision:catalogRevision,items});
  }catch(error){console.error("GET /api/menu/availability:",error);return res.status(500).json({error:"Failed to load availability"})}
});

app.get("/api/menu", async (req, res) => {
  try {
    const menuSurface = String(req.query?.surface || "").toLowerCase() === "menu";
    const loadCategories = visibilityColumn => supabase.from("categories").select("id,name,color,sort_order,is_active,external_id").eq("is_active", true).eq(visibilityColumn, true).order("sort_order", { ascending: true }).order("name", { ascending: true });
    let { data: categories, error: categoriesError } = await loadCategories(menuSurface ? "visible_in_menu" : "available_online");
    if (missingCategoryChannelColumn(categoriesError)) ({ data: categories, error: categoriesError } = await supabase.from("categories").select("id,name,color,sort_order,is_active,external_id").eq("is_active", true).order("sort_order", { ascending: true }).order("name", { ascending: true }));
    if (categoriesError) throw categoriesError;
    const loadProducts = visibilityColumn => supabase.from("products").select("id,name,description,price,category_id,image_url,sort_order,is_active,available_online,external_id").eq("is_active", true).eq(visibilityColumn, true).order("sort_order", { ascending: true }).order("name", { ascending: true });
    let { data: products, error: productsError } = await loadProducts(menuSurface ? "visible_in_menu" : "available_online");
    if (menuSurface && missingOnlineMenuColumn(productsError)) ({ data: products, error: productsError } = await loadProducts("available_online"));
    if (productsError) throw productsError;
    const allowedCategoryIds = new Set((categories ?? []).map(c => c.id));
    const surfaceProducts = (products ?? []).filter(p => !p.category_id || allowedCategoryIds.has(p.category_id));
    const onlineCategoryIds = new Set(surfaceProducts.map(p => p.category_id).filter(Boolean));
    const availableProducts=await availability.attachToProducts(surfaceProducts);
    const versioned=String(req.query?.revision||"")===catalogRevision;
    res.setHeader?.("Cache-Control",versioned?(menuSurface?"public, max-age=604800, immutable":"private, max-age=604800, immutable"):(menuSurface?"public, max-age=1800":"private, max-age=120"));
    res.setHeader?.("X-Catalog-Revision",catalogRevision);
    res.json({ catalog_revision:catalogRevision,categories: (categories ?? []).filter(c => onlineCategoryIds.has(c.id)), products: availableProducts });
  } catch (error) { console.error("GET /api/menu:", error); res.status(500).json({ error: "Failed to load menu" }); }
});

const eventClients = new Set(); let eventPollBusy = false;
async function pushNewOrders(){
  if(typeof isSiteSleepWindow==="function"&&isSiteSleepWindow()){
    const retry=Math.ceil(millisecondsUntilSiteWake());
    for(const client of eventClients){try{client.res.write(`retry: ${retry}\nevent: sleeping\ndata: {}\n\n`);client.res.end()}catch(_error){}}
    eventClients.clear();return;
  }
  if(eventPollBusy || !eventClients.size) return; eventPollBusy = true;
  try { const { data, error } = await supabase.from("orders").select("id,external_id,status,order_type,customer_id,customer_name,phone,address,comment,total,delivery_fee,created_at,updated_at,order_items(id,product_id,external_product_id,product_name,price,quantity,comment)").eq("status", "new").order("created_at", { ascending: false }).limit(20); if(error) throw error; const payload = JSON.stringify({type:"orders",orders:data||[]}); for(const client of eventClients){ try { client.res.write(`data: ${payload}\n\n`); } catch(e) {} } }
  catch(error){ console.error("order event poll:", error); } finally { eventPollBusy = false; }
}
setInterval(pushNewOrders, 2000);

app.get("/api/orders/events", async (req, res) => {
  try {
    if(siteSleepingNow()){res.setHeader("Content-Type","text/event-stream; charset=utf-8");res.setHeader("Cache-Control","no-store");res.write(`retry: ${Math.ceil(millisecondsUntilSiteWake())}\nevent: sleeping\ndata: {}\n\n`);return res.end()}
    const deviceKey = String(req.header("x-device-key") || req.query.deviceKey || "").trim();
    if(!deviceKey) return res.status(401).json({error:"Missing device key"});
    const { data: device, error } = await supabase.from("devices").select("id").eq("device_key", deviceKey).eq("is_active", true).maybeSingle();
    if(error) throw error;
    if(!device) return res.status(401).json({error:"Invalid device key"});
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8"); res.setHeader("Cache-Control", "no-cache, no-transform"); res.setHeader("Connection", "keep-alive"); res.setHeader("X-Accel-Buffering", "no"); res.flushHeaders?.();
    const client={res,deviceKey,deviceId:device.id}; eventClients.add(client); res.write(`event: ready\ndata: ${JSON.stringify({ok:true})}\n\n`); const heartbeat=setInterval(()=>{ try{res.write(`: ping\n\n`);}catch(e){} }, 15000); req.on("close",()=>{clearInterval(heartbeat);eventClients.delete(client);}); pushNewOrders();
  } catch(error) { console.error("GET /api/orders/events:", error); if(!res.headersSent) return res.status(500).json({error:"Failed to open order stream"}); res.end(); }
});

async function requireDevice(req,res){
  const deviceKey=String(req.header("x-device-key")||req.body?.deviceKey||"").trim();
  if(!deviceKey){res.status(401).json({error:"Missing device key"});return null}
  const {data,error}=await supabase.from("devices").select("id").eq("device_key",deviceKey).eq("is_active",true).maybeSingle();
  if(error)throw error;if(!data){res.status(401).json({error:"Invalid device key"});return null}return data;
}
async function saveDeviceTelegramSettings(req, res) {
  try {
    const device = await requireDevice(req, res);
    if (!device) return;
    const result = await telegramOrderAlerts.configure(device.id, {
      chatId: req.body?.chatId,
      ownerChatId: req.body?.ownerChatId,
      enabled: req.body?.enabled === true,
    });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (error) {
    console.error("PUT device Telegram settings:", error);
    return res.status(500).json({ error: "Не удалось сохранить настройки Telegram" });
  }
}
app.put("/api/device/telegram-settings", saveDeviceTelegramSettings);
// Compatibility for POS builds that only knew the order-notification setting.
app.put("/api/device/telegram-order-notifications", saveDeviceTelegramSettings);

function deliverLiveReportRequest(deviceId, payload) {
  const clients = [...eventClients].filter(client => client.deviceId === deviceId);
  let delivered = false;
  for (const client of clients) {
    try {
      client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
      delivered = true;
    } catch (_error) {
      eventClients.delete(client);
    }
  }
  return delivered;
}
function liveReportError(res, error) {
  return res.status(error.status || 503).json({
    error: error.status ? error.message : "Сервис отчётов временно недоступен",
    code: error.code || "LIVE_REPORT_UNAVAILABLE",
  });
}
function requireOwnerBot(req, res) {
  if (ownerBotAuthorized(req.header("x-owner-bot-secret"), process.env.OWNER_BOT_SHARED_SECRET)) return true;
  res.status(403).json({ error: "Доступ запрещён", code: "OWNER_FORBIDDEN" });
  return false;
}
app.post("/api/owner/live-report/access", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!requireOwnerBot(req, res)) return;
    return res.json(await livePosReports.access(req.body?.telegramId));
  } catch (error) {
    return liveReportError(res, error);
  }
});
app.post("/api/owner/live-report", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!requireOwnerBot(req, res)) return;
    return res.json(await livePosReports.request(req.body?.telegramId, deliverLiveReportRequest));
  } catch (error) {
    return liveReportError(res, error);
  }
});
app.post("/api/device/live-report/:requestId", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const device = await requireDevice(req, res);
    if (!device) return;
    if (!livePosReports.submit(device.id, req.params.requestId, req.body?.report)) {
      return res.status(404).json({ error: "Запрос отчёта завершён", code: "LIVE_REPORT_EXPIRED" });
    }
    return res.json({ ok: true });
  } catch (error) {
    return liveReportError(res, error);
  }
});
async function customerLoyalty(customerId){
  const {data:programs,error}=await supabase.from("loyalty_programs").select("id,name,required_quantity,reward_quantity,is_active,loyalty_earning_products(product_id),loyalty_reward_products(product_id)").eq("is_active",true).order("created_at");
  if(error)throw error;
  const result=[];
  for(const p of programs||[]){const {data:b,error:be}=await supabase.rpc("loyalty_balance",{p_customer_id:customerId,p_program_id:p.id});if(be)throw be;const balance=Array.isArray(b)?b[0]:b;result.push({...p,progress:Number(balance?.progress||0),rewards:Number(balance?.rewards||0)});}
  return result;
}
function customerSearchFilter(value) {
  const q = String(value || "").trim();
  const compact = q.replace(/[\s()-]/g, "");
  if (/^\+375\d{4,9}$/.test(compact)) return { column: "normalized_phone", pattern: compact + "%" };
  if (/^\d{4}$/.test(compact)) return { column: "normalized_phone", pattern: "%" + compact };
  const phone = normalizePhone(q);
  return phone ? { column: "normalized_phone", pattern: "%" + phone + "%" } : { column: "name", pattern: "%" + q + "%" };
}
app.get("/api/customers/search",async(req,res)=>{try{if(!await requireDevice(req,res))return;const q=String(req.query.q||"").trim();if(q.length<2)return res.json({customers:[]});const filter=customerSearchFilter(q);let query=supabase.from("customers").select("id,name,normalized_phone,telegram_user_id,telegram_username,last_purchase_at").limit(20);query=query.ilike(filter.column,filter.pattern);const {data,error}=await query;if(error)throw error;res.json({customers:data||[]});}catch(e){console.error("customer search",e);res.status(500).json({error:"Failed to search customers"})}});
app.post("/api/customers",async(req,res)=>{try{if(!await requireDevice(req,res))return;const name=String(req.body?.name||"").trim(),phone=normalizePhone(req.body?.phone);if(!name||!phone)return res.status(400).json({error:"Name and phone are required"});const {data,error}=await supabase.from("customers").insert({name,normalized_phone:phone}).select("id,name,normalized_phone,telegram_user_id,telegram_username,last_purchase_at").single();if(error?.code==="23505")return res.status(409).json({error:"Customer already exists"});if(error)throw error;res.status(201).json({customer:data});}catch(e){console.error("customer create",e);res.status(500).json({error:"Failed to create customer"})}});
app.get("/api/customers/:id/loyalty",async(req,res)=>{try{if(!await requireDevice(req,res))return;const {data:customer,error}=await supabase.from("customers").select("id,name,normalized_phone,telegram_user_id,telegram_username,last_purchase_at").eq("id",req.params.id).maybeSingle();if(error)throw error;if(!customer)return res.status(404).json({error:"Customer not found"});res.json({customer,programs:await customerLoyalty(customer.id)});}catch(e){console.error("customer loyalty",e);res.status(500).json({error:"Failed to load loyalty"})}});
app.get("/api/loyalty/programs",async(req,res)=>{try{if(!await requireDevice(req,res))return;const {data,error}=await supabase.from("loyalty_programs").select("id,name,required_quantity,reward_quantity,is_active,loyalty_earning_products(product_id),loyalty_reward_products(product_id)").order("created_at");if(error)throw error;res.json({programs:data||[]});}catch(e){res.status(500).json({error:"Failed to load programs"})}});
app.post("/api/loyalty/programs",async(req,res)=>{let createdProgramId="";try{if(!await requireDevice(req,res))return;const name=String(req.body?.name||"").trim(),required=Math.trunc(Number(req.body?.requiredQuantity)),reward=1;if(!name||required<1)return res.status(400).json({error:"Invalid loyalty program"});const {data:p,error}=await supabase.from("loyalty_programs").insert({name,required_quantity:required,reward_quantity:reward,is_active:req.body?.isActive!==false}).select().single();if(error)throw error;createdProgramId=p.id;const earning=[...new Set((req.body?.earningProductIds||[]).map(String))].map(product_id=>({program_id:p.id,product_id}));const rewards=[...new Set((req.body?.rewardProductIds||[]).map(String))].map(product_id=>({program_id:p.id,product_id}));if(earning.length){const {error:e}=await supabase.from("loyalty_earning_products").insert(earning);if(e)throw e}if(rewards.length){const {error:e}=await supabase.from("loyalty_reward_products").insert(rewards);if(e)throw e}res.status(201).json({program:p});}catch(e){console.error("loyalty program",e);if(createdProgramId){const cleanup=await supabase.from("loyalty_programs").delete().eq("id",createdProgramId);if(cleanup.error)console.error("loyalty program cleanup",cleanup.error)}res.status(500).json({error:"Failed to create program"})}});
app.put("/api/loyalty/programs/:id",async(req,res)=>{try{if(!await requireDevice(req,res))return;const id=String(req.params.id||"").trim(),name=String(req.body?.name||"").trim(),required=Math.trunc(Number(req.body?.requiredQuantity)),reward=1,earningIds=[...new Set((req.body?.earningProductIds||[]).map(String))],rewardIds=[...new Set((req.body?.rewardProductIds||[]).map(String))];if(!id||!name||required<1||!earningIds.length||!rewardIds.length)return res.status(400).json({error:"Invalid loyalty program"});const {data:p,error}=await supabase.rpc("replace_loyalty_program",{p_program_id:id,p_name:name,p_required:required,p_reward:reward,p_is_active:req.body?.isActive!==false,p_earning_ids:earningIds,p_reward_ids:rewardIds});if(error)throw error;res.json({program:p});}catch(e){console.error("loyalty program update",e);res.status(500).json({error:"Failed to update program"})}});
app.patch("/api/loyalty/programs/:id/active",async(req,res)=>{try{if(!await requireDevice(req,res))return;const {data,error}=await supabase.from("loyalty_programs").update({is_active:Boolean(req.body?.isActive),updated_at:new Date().toISOString()}).eq("id",req.params.id).select().single();if(error)throw error;res.json({program:data});}catch(e){console.error("loyalty program active",e);res.status(500).json({error:"Failed to update program state"})}});
app.delete("/api/loyalty/programs/:id",async(req,res)=>{try{if(!await requireDevice(req,res))return;const id=String(req.params.id||"").trim();if(!id)return res.status(400).json({error:"Missing loyalty program"});const {count,error:ledgerError}=await supabase.from("loyalty_ledger").select("id",{count:"exact",head:true}).eq("program_id",id);if(ledgerError)throw ledgerError;if(Number(count||0)>0)return res.status(409).json({error:"Program has loyalty history and cannot be deleted. Disable it instead."});const {error}=await supabase.from("loyalty_programs").delete().eq("id",id);if(error)throw error;res.json({ok:true});}catch(e){console.error("loyalty program delete",e);res.status(500).json({error:"Failed to delete program"})}});


app.post("/api/loyalty/sales",async(req,res)=>{
  try{
    if(!await requireDevice(req,res))return;
    const orderId=String(req.body?.orderId||"").trim(),customerId=String(req.body?.customerId||"").trim();
    const items=Array.isArray(req.body?.items)?req.body.items:[],redemptions=req.body?.redemptions||{},rewardAllocations=req.body?.rewardAllocations||{};
    if(!orderId||!customerId)return res.status(400).json({error:"Missing loyalty sale identity"});
    const programs=await customerLoyalty(customerId),events=[];
    let allocation;
    try{allocation=validateLoyaltyAllocation({items,programs,redemptions,rewardAllocations})}
    catch(e){return res.status(409).json({error:"Invalid loyalty reward allocation",reason:String(e.message||e)})}
    for(const p of programs){
      const earningIds=new Set((p.loyalty_earning_products||[]).map(x=>String(x.product_id)));
      const earned=[...allocation.paidByProduct].filter(([productId])=>earningIds.has(productId)).reduce((sum,[,quantity])=>sum+quantity,0);
      const redeem=allocation.allocatedByProgram.get(String(p.id))||0;
      if(!earned&&!redeem)continue;
      const key=loyaltyIdempotencyKey(orderId,p.id,"sale");
      const {data,error}=await supabase.rpc("apply_loyalty_sale",{p_customer_id:customerId,p_program_id:p.id,p_idempotency_key:key,p_pos_order_id:orderId,p_earned:earned,p_redeem:redeem,p_required:p.required_quantity,p_reward_each:p.reward_quantity});
      if(error){if(String(error.message||"").includes("INSUFFICIENT_LOYALTY_REWARDS"))return res.status(409).json({error:"Insufficient loyalty rewards",programId:p.id});throw error}
      const x=Array.isArray(data)?data[0]:data;
      events.push({programId:p.id,earned,redeemed:Number(x?.redeemed||0),granted:Number(x?.granted||0),progress:Number(x?.progress||0),rewards:Number(x?.rewards||0),duplicate:Boolean(x?.duplicate)});
    }
    await supabase.from("customers").update({last_purchase_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",customerId);
    const finalPrograms=await customerLoyalty(customerId);
    const {data:customer}=await supabase.from("customers").select("telegram_user_id").eq("id",customerId).maybeSingle();
    res.json({ok:true,events,programs:finalPrograms,telegramUserId:customer?.telegram_user_id||null,loyaltyMessage:formatLoyaltySaleMessage(events,finalPrograms)});
  }catch(e){console.error("loyalty sale",e);res.status(500).json({error:"Failed to apply loyalty"})}
});

app.post("/api/loyalty/reversal",async(req,res)=>{
  try{
    if(!await requireDevice(req,res))return;
    const orderId=String(req.body?.orderId||"").trim(),customerId=String(req.body?.customerId||"").trim();
    if(!orderId||!customerId)return res.status(400).json({error:"Missing reversal identity"});
    const {data,error}=await supabase.rpc("apply_single_reward_reversal",{p_customer_id:customerId,p_pos_order_id:orderId});
    if(error)throw error;
    res.json({ok:true,reversed:Number(data||0),programs:await customerLoyalty(customerId)});
  }catch(e){console.error("loyalty reversal",e);res.status(500).json({error:"Failed to reverse loyalty"})}
});

app.get("/api/analytics/loyalty",async(req,res)=>{try{if(!await requireDevice(req,res))return;const from=String(req.query?.from||"").trim(),to=String(req.query?.to||"").trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to))return res.status(400).json({error:"Invalid analytics range"});const start=from+"T00:00:00.000Z",end=new Date(to+"T00:00:00.000Z");end.setUTCDate(end.getUTCDate()+1);const endIso=end.toISOString();const [{data:orders,error:oe},{data:ledger,error:le},{data:customers,error:ce}]=await Promise.all([supabase.from("orders").select("id,customer_id,total,status,created_at").not("customer_id","is",null).gte("created_at",start).lt("created_at",endIso),supabase.from("loyalty_ledger").select("customer_id,operation_type,reward_delta,metadata,created_at").gte("created_at",start).lt("created_at",endIso),supabase.from("customers").select("id,created_at")]);if(oe)throw oe;if(le)throw le;if(ce)throw ce;const paid=(orders||[]).filter(x=>!["cancelled","canceled"].includes(String(x.status||"").toLowerCase())),customerIds=new Set(paid.map(x=>x.customer_id)),newCustomers=(customers||[]).filter(x=>x.created_at>=start&&x.created_at<endIso).length,repeatCustomers=[...customerIds].filter(id=>paid.filter(x=>x.customer_id===id).length>1).length,customerRevenue=paid.reduce((s,x)=>s+Number(x.total||0),0),granted=(ledger||[]).filter(x=>x.operation_type==="REWARD_GRANTED").reduce((s,x)=>s+Math.max(0,Number(x.reward_delta||0)),0),redeemed=(ledger||[]).filter(x=>x.operation_type==="REWARD_REDEEMED").reduce((s,x)=>s+Math.max(0,-Number(x.reward_delta||0)),0),activeLoyalty=new Set((ledger||[]).filter(x=>["EARN","REWARD_GRANTED","REWARD_REDEEMED"].includes(x.operation_type)).map(x=>x.customer_id)).size;res.json({customers:customerIds.size,newCustomers,repeatCustomers,customerOrders:paid.length,customerRevenue,averageCustomerCheck:paid.length?customerRevenue/paid.length:0,activeLoyaltyUsers:activeLoyalty,rewardsGranted:granted,rewardsRedeemed:redeemed});}catch(e){console.error("loyalty analytics",e);res.status(500).json({error:"Failed to load loyalty analytics"})}});

app.get("/api/customers/:id/orders",async(req,res)=>{try{if(!await requireDevice(req,res))return;const {data,error}=await supabase.from("orders").select("id,external_id,status,total,created_at,order_items(product_name,quantity,price)").eq("customer_id",req.params.id).order("created_at",{ascending:false}).limit(100);if(error)throw error;res.json({orders:data||[]});}catch(e){console.error("customer orders",e);res.status(500).json({error:"Failed to load customer orders"})}});
app.get("/api/customers/:id/ledger",async(req,res)=>{try{if(!await requireDevice(req,res))return;const {data,error}=await supabase.from("loyalty_ledger").select("id,program_id,operation_type,progress_delta,reward_delta,metadata,created_at,loyalty_programs(name)").eq("customer_id",req.params.id).order("created_at",{ascending:false}).limit(100);if(error)throw error;res.json({ledger:data||[]});}catch(e){console.error("loyalty ledger",e);res.status(500).json({error:"Failed to load loyalty ledger"})}});
app.post("/api/customers/:id/loyalty-adjustment",async(req,res)=>{
  try{
    if(!await requireDevice(req,res))return;
    const programId=String(req.body?.programId||"").trim(),reason=String(req.body?.reason||"").trim(),adminEmployeeId=String(req.body?.adminEmployeeId||"").trim(),adminEmployeeName=String(req.body?.adminEmployeeName||"").trim(),adminPassword=String(req.body?.adminPassword||""),progressDelta=Math.trunc(Number(req.body?.progressDelta)||0),rewardDelta=Math.trunc(Number(req.body?.rewardDelta)||0);
    if(!process.env.POS_ADMIN_PASSWORD||adminPassword!==process.env.POS_ADMIN_PASSWORD)return res.status(403).json({error:"Administrator authorization required"});
    if(!programId||!reason||!adminEmployeeId||!adminEmployeeName||(!progressDelta&&!rewardDelta))return res.status(400).json({error:"Program, reason, administrator and adjustment are required"});
    const key=`manual:${req.params.id}:${programId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const {error}=await supabase.rpc("apply_single_reward_adjustment",{p_customer_id:req.params.id,p_program_id:programId,p_progress_delta:progressDelta,p_reward_delta:rewardDelta,p_idempotency_key:key,p_metadata:{reason,adminEmployeeId,adminEmployeeName}});
    if(error){if(String(error.message||"").includes("INVALID_SINGLE_REWARD_BALANCE"))return res.status(409).json({error:"Loyalty balance must contain at most one reward and no progress while it is available"});throw error}
    res.json({ok:true,programs:await customerLoyalty(req.params.id)});
  }catch(e){console.error("loyalty adjustment",e);res.status(500).json({error:"Failed to adjust loyalty"})}
});

app.get("/api/config", (_req, res) => res.json({ deliveryFee: Number.isFinite(deliveryFee) ? deliveryFee : 0,orderingOpen:orderingOpenNow(),orderHours:{opensAt:"10:00",closesAt:"22:30",timeZone:VENUE_TIME_ZONE} }));

app.post("/api/orders", async (req, res) => {
  try {
    const orderType = String(req.body?.orderType || "Самовывоз").trim();
    const customerName = String(req.body?.customerName || "").trim();
    const rawPhone = String(req.body?.phone || "").trim();
    const phone = normalizePhone(rawPhone);
    const verificationToken = String(req.body?.verificationToken || "").trim();
    const address = String(req.body?.address || "").trim();
    const comment = String(req.body?.comment || "").trim();
    const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!customerName || !phone || !requestedItems.length) return res.status(400).json({ error: "Заполните данные заказа и добавьте товары" });
    if (orderType === "Доставка" && !address) return res.status(400).json({ error: "Укажите адрес доставки" });
    if (!verificationToken) return res.status(403).json({ error: "Подтвердите номер телефона через Telegram" });

    const verification = await phoneVerification.get(verificationToken);
    if (!verification || verification.status !== "VERIFIED" || verification.phone !== phone) return res.status(403).json({ error: "Номер телефона не подтверждён" });

    const contactError = validateOrderContact({ phone: rawPhone, comment, items: requestedItems });
    if (contactError) return res.status(400).json({ error: contactError });
    const ids = requestedItems.map(x => String(x.productId || "").trim()).filter(Boolean); const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length || uniqueIds.length !== ids.length) return res.status(400).json({ error: "Некорректные товары в заказе" });
    const { data: products, error: productsError } = await supabase.from("products").select("id,external_id,name,price").in("id", uniqueIds).eq("is_active", true).eq("available_online", true);
    if (productsError) throw productsError;
    const productMap = new Map((products || []).map(p => [p.id, p]));
    if (productMap.size !== uniqueIds.length) return res.status(400).json({ error: "Один из товаров больше недоступен для заказа" });
    const items = []; let subtotal = 0;
    for (const raw of requestedItems) { const product = productMap.get(String(raw.productId)); const quantity = Number(raw.quantity); if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 99) return res.status(400).json({ error: "Некорректное количество товара" }); subtotal += Number(product.price || 0) * quantity; items.push({ product_id: product.id, external_product_id: product.external_id, product_name: product.name, price: Number(product.price || 0), quantity, comment: raw.comment ? String(raw.comment).trim().slice(0, 500) : null }); }

    const consumed = await phoneVerification.consume(verificationToken, phone);
    if (!consumed) return res.status(409).json({ error: "Подтверждение уже использовано. Подтвердите номер ещё раз" });

    const fee = orderType === "Доставка" ? (Number.isFinite(deliveryFee) ? deliveryFee : 0) : 0; const total = subtotal + fee;
    const externalId = `WEB-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`; const trackingToken = randomUUID().replace(/-/g, "");
    const { data: order, error: orderError } = await supabase.rpc("create_web_order",{p_external_id:externalId,p_tracking_token:trackingToken,p_order_type:orderType,p_customer_name:customerName,p_phone:phone,p_address:orderType==="Доставка"?address:null,p_comment:comment||null,p_total:total,p_delivery_fee:fee,p_items:items});
    if (orderError) throw orderError;
    const created=Array.isArray(order)?order[0]:order;
    if(!created?.id)throw new Error("Atomic order creation returned no order");
    res.status(201).json({ ok: true, orderId: created.id, externalId, trackingToken, total, deliveryFee: fee });
  } catch (error) { const message=String(error?.message||"");console.error("POST /api/orders:", error);if(message.includes("OUT_OF_STOCK"))return res.status(409).json({error:"Товар закончился или его осталось недостаточно"});if(message.includes("AVAILABILITY_UNAVAILABLE"))return res.status(409).json({error:"Актуальные остатки временно недоступны"});res.status(500).json({ error: "Не удалось создать заказ" }); }
});

app.get("/api/orders/:token", async (req, res) => {
  try { const token = String(req.params.token || "").trim(); if (!token) return res.status(400).json({ error: "Missing token" }); const { data: order, error } = await supabase.from("orders").select("id,external_id,status,order_type,customer_name,phone,address,comment,total,delivery_fee,created_at,updated_at,order_items(product_name,price,quantity,comment)").eq("tracking_token", token).maybeSingle(); if (error) throw error; if (!order) return res.status(404).json({ error: "Заказ не найден" }); res.json({ order }); }
  catch (error) { console.error("GET /api/orders/:token:", error); res.status(500).json({ error: "Не удалось загрузить заказ" }); }
});

app.post("/api/orders/:id/accept", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || req.body?.deviceKey || "").trim();
    const id = String(req.params.id || "").trim();
    if (!deviceKey) return res.status(401).json({ error: "Missing device key" });
    if (!id) return res.status(400).json({ error: "Invalid order id" });

    const { data: device, error: deviceError } = await supabase.from("devices").select("id").eq("device_key", deviceKey).eq("is_active", true).maybeSingle();
    if (deviceError) throw deviceError;
    if (!device) return res.status(401).json({ error: "Invalid device key" });

    const { data: existing, error: existingError } = await supabase.from("orders").select("id,status,external_id,updated_at").eq("id", id).maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return res.status(404).json({ error: "Заказ не найден" });

    if (existing.status === "accepted") return res.json({ ok: true, order: existing, alreadyAccepted: true });
    if (existing.status !== "new") return res.status(409).json({ error: "Заказ уже изменил статус", order: existing });

    const { data: order, error } = await supabase.from("orders").update({ status: "accepted", updated_at: new Date().toISOString() }).eq("id", id).eq("status", "new").select("id,status,external_id,updated_at").maybeSingle();
    if (error) throw error;
    if (!order) {
      const { data: current, error: currentError } = await supabase.from("orders").select("id,status,external_id,updated_at").eq("id", id).maybeSingle();
      if (currentError) throw currentError;
      if (current?.status === "accepted") return res.json({ ok: true, order: current, alreadyAccepted: true });
      return res.status(409).json({ error: "Заказ уже изменил статус", order: current || null });
    }

    return res.json({ ok: true, order });
  } catch (error) {
    console.error("POST /api/orders/:id/accept:", error);
    return res.status(500).json({ error: "Не удалось принять заказ" });
  }
});

app.patch("/api/orders/:id/status", async (req, res) => {
  try { const deviceKey = String(req.header("x-device-key") || "").trim(); const id = String(req.params.id || "").trim(); const status = String(req.body?.status || "").trim(); const allowed = new Set(["new", "accepted", "preparing", "ready", "cancelled"]); if (!deviceKey) return res.status(401).json({ error: "Missing device key" }); if (!id || !allowed.has(status)) return res.status(400).json({ error: "Invalid status" }); const { data: device, error: deviceError } = await supabase.from("devices").select("id").eq("device_key", deviceKey).eq("is_active", true).maybeSingle(); if (deviceError) throw deviceError; if (!device) return res.status(401).json({ error: "Invalid device key" }); const { data: order, error } = await supabase.from("orders").update({ status, updated_at: new Date().toISOString() }).eq("id", id).select("id,status,updated_at").single(); if (error) throw error; res.json({ ok: true, order }); }
  catch (error) { console.error("PATCH /api/orders/:id/status:", error); res.status(500).json({ error: "Не удалось обновить статус заказа" }); }
});

app.listen(port, () => console.log(`Prilavok backend listening on ${port}`));
