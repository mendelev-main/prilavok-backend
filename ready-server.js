import express from "express";
import { createClient } from "@supabase/supabase-js";

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
