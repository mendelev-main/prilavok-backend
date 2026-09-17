import express from "express";
import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";

// Keep server.js as the main application. Capture its Express app when it starts
// listening, then add the small POS status extension without duplicating the server.
let runningApp = null;
const originalListen = express.application.listen;
express.application.listen = function (...args) {
  runningApp = this;
  return originalListen.apply(this, args);
};

await import("./server.js");
express.application.listen = originalListen;

if (!runningApp) throw new Error("Prilavok backend app was not initialized");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) throw new Error("Missing Supabase configuration");
const supabase = createClient(supabaseUrl, supabaseKey);

// The original page stopped polling as soon as POS accepted an order. Serve the
// same page with only the tracking state machine adjusted: accepted keeps polling,
// ready is terminal and is shown to the customer as "Заказ готов".
runningApp.get("/", async (_req, res) => {
  try {
    let html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
    const oldStatus = "function statusInfo(status){return ['accepted','in_work','ready','delivering','completed'].includes(status)?['Заказ подтверждён','',true]:status==='new'?['Ожидает подтверждения','',false]:['Статус уточняется','',false]}";
    const newStatus = "function statusInfo(status){return status==='ready'?['Заказ готов','Можно забирать заказ.',true]:status==='accepted'||status==='in_work'?['Заказ готовится','Мы уже начали готовить ваш заказ.',false]:status==='completed'?['Заказ выполнен','Спасибо за заказ!',true]:status==='delivering'?['Заказ в доставке','Заказ передан в доставку.',false]:status==='new'?['Ожидает подтверждения','',false]:['Статус уточняется','',false]}";
    if (!html.includes(oldStatus)) throw new Error("Tracking status function not found");
    html = html.replace(oldStatus, newStatus);
    res.type("html").send(html);
  } catch (error) {
    console.error("GET / tracking override:", error);
    res.status(500).send("Не удалось загрузить меню");
  }
});

// server.js registered express.static before this extension. Move only our exact
// root route ahead of static so all other assets/API routes keep their order.
const stack = runningApp.router?.stack;
if (Array.isArray(stack)) {
  const index = stack.findIndex(layer => layer.route?.path === "/" && layer.route?.methods?.get);
  if (index >= 0) {
    const [rootLayer] = stack.splice(index, 1);
    stack.unshift(rootLayer);
  }
}

runningApp.post("/api/orders/:id/ready", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || req.body?.deviceKey || "").trim();
    const id = String(req.params.id || "").trim();
    if (!deviceKey) return res.status(401).json({ error: "Missing device key" });
    if (!id) return res.status(400).json({ error: "Invalid order id" });

    const { data: device, error: deviceError } = await supabase.from("devices").select("id").eq("device_key", deviceKey).eq("is_active", true).maybeSingle();
    if (deviceError) throw deviceError;
    if (!device) return res.status(401).json({ error: "Invalid device key" });

    const { data: existing, error: existingError } = await supabase.from("orders").select("id,status,updated_at").eq("id", id).maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return res.status(404).json({ error: "Заказ не найден" });
    if (existing.status === "ready") return res.json({ ok: true, order: existing, alreadyReady: true });
    if (existing.status !== "accepted") return res.status(409).json({ error: "Сначала заказ должен быть взят в работу", order: existing });

    const { data: order, error } = await supabase.from("orders").update({ status: "ready", updated_at: new Date().toISOString() }).eq("id", id).eq("status", "accepted").select("id,status,updated_at").maybeSingle();
    if (error) throw error;
    if (!order) return res.status(409).json({ error: "Статус заказа уже изменился" });
    return res.json({ ok: true, order });
  } catch (error) {
    console.error("POST /api/orders/:id/ready:", error);
    return res.status(500).json({ error: "Не удалось отметить заказ готовым" });
  }
});
