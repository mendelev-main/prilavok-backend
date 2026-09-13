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



// Lightweight realtime stream for POS devices. Supabase remains the source of truth;
// the backend checks for new orders and pushes them immediately to connected iPads.
const eventClients = new Set();
let eventPollBusy = false;
async function pushNewOrders(){
  if(eventPollBusy || !eventClients.size) return;
  eventPollBusy = true;
  try{
    const { data, error } = await supabase
      .from("orders")
      .select("id,external_id,status,order_type,customer_name,phone,address,comment,total,delivery_fee,created_at,updated_at,order_items(id,product_id,external_product_id,product_name,price,quantity,comment)")
      .eq("status", "new")
      .order("created_at", { ascending: false })
      .limit(20);
    if(error) throw error;
    const payload = JSON.stringify({type:"orders",orders:data||[]});
    for(const client of eventClients){
      try { client.res.write(`data: ${payload}\n\n`); } catch(e) {}
    }
  } catch(error){
    console.error("order event poll:", error);
  } finally { eventPollBusy = false; }
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
    const {data:order,error:orderError}=await supabase.from("orders").insert({
      external_id:`TEST-${Date.now()}`,
      status:"new", order_type:"Доставка", customer_name:"Тестовый клиент", phone:"+375 29 000-00-00",
      address:"Тестовый адрес, 1", comment:"Тестовый веб-заказ", total, delivery_fee:5
    }).select("*").single();
    if(orderError) throw orderError;
    const {error:itemError}=await supabase.from("order_items").insert({order_id:order.id,product_id:product.id,external_product_id:product.external_id,product_name:product.name,price:Number(product.price||0),quantity:qty,comment:null});
    if(itemError) throw itemError;
    res.json({ok:true,orderId:order.id,externalId:order.external_id});
  } catch(error){
    console.error("POST /api/orders/test:",error);
    res.status(500).json({error:"Failed to create test order"});
  }
});

app.post("/api/orders/:id/accept", async (req,res)=>{
  try{
    const deviceKey=String(req.header("x-device-key")||req.body?.deviceKey||"").trim();
    if(!deviceKey) return res.status(401).json({error:"Missing device key"});
    const {data:device}=await supabase.from("devices").select("id").eq("device_key",deviceKey).eq("is_active",true).maybeSingle();
    if(!device) return res.status(403).json({error:"Unknown device"});
    const {data:order,error}=await supabase.from("orders").update({status:"accepted",updated_at:new Date().toISOString()}).eq("id",req.params.id).eq("status","new").select("id,status").maybeSingle();
    if(error) throw error;
    if(!order) return res.status(409).json({error:"Order is no longer new"});
    res.json({ok:true,order});
  } catch(error){ console.error("POST /api/orders/:id/accept:",error); res.status(500).json({error:"Failed to accept order"}); }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Prilavok backend listening on port ${port}`);
});
