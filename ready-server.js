import express from "express";
import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";

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

// Customer tracking has exactly three public stages:
// new -> Заказ создан, accepted -> Заказ подтвержден, ready -> Заказ готов.
runningApp.get("/", async (_req, res) => {
  try {
    let html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
    const oldStatus = "function statusInfo(status){return ['accepted','in_work','ready','delivering','completed'].includes(status)?['Заказ подтверждён','',true]:status==='new'?['Ожидает подтверждения','',false]:['Статус уточняется','',false]}";
    const newStatus = "function statusInfo(status){return status==='ready'?['Заказ готов','',true]:status==='accepted'||status==='in_work'?['Заказ подтвержден','',false]:status==='new'?['Заказ создан','',false]:['Статус уточняется','',false]}";
    if (!html.includes(oldStatus)) throw new Error("Tracking status function not found");
    html = html.replace(oldStatus, newStatus);

    const oldRender = "function renderTracking(o){const card=document.getElementById('trackingCard');if(!card)return;const [label,note,confirmed]=statusInfo(o.status);const items=(o.order_items||[]).map(i=>`<div class=\"tracking-item\"><span>${esc(i.product_name)} × ${Number(i.quantity||0)}</span><b>${money(Number(i.price||0)*Number(i.quantity||0))}</b></div>`).join('');card.innerHTML=`<div class=\"tracking-title\">Ваш заказ</div><div class=\"tracking-id\">${esc(o.external_id||'')}</div><div class=\"status-line\">${confirmed?'<span class=\"status-check\" aria-hidden=\"true\">✓</span>':''}<div><div class=\"status-text\">${esc(label)}</div><div class=\"status-note\">${esc(note)}</div></div></div><div class=\"tracking-items\">${items}<div class=\"total\" style=\"padding-bottom:0\"><span>Итого</span><span>${money(o.total)}</span></div></div><div class=\"tracking-actions\"><button class=\"primary\" onclick=\"loadTracking(true)\">Обновить</button><button onclick=\"hideTracking()\">Скрыть</button></div>`;if(confirmed){clearInterval(trackingTimer);trackingTimer=null;}}";
    const newRender = "function renderTracking(o){const card=document.getElementById('trackingCard');if(!card)return;const stages=['Заказ создан','Заказ подтвержден','Заказ готов'];const step=o.status==='ready'?2:(o.status==='accepted'||o.status==='in_work'?1:0);const pipeline=`<div style=\"display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;margin:18px 0 4px\">${stages.map((name,i)=>`<div style=\"position:relative;text-align:center;min-width:0\"><div style=\"height:4px;background:${i<=step?'#171717':'#e3e3df'};position:absolute;left:${i===0?'50%':'0'};right:${i===2?'50%':'0'};top:10px\"></div><div style=\"position:relative;margin:auto;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:${i<=step?'#171717':'#e3e3df'};color:white;font-size:13px;font-weight:800\">${i<step?'✓':i+1}</div><div style=\"font-size:12px;line-height:1.25;margin-top:8px;font-weight:${i===step?'750':'550'};color:${i<=step?'#171717':'#999'}\">${name}</div></div>`).join('')}</div>`;const items=(o.order_items||[]).map(i=>`<div class=\"tracking-item\"><span>${esc(i.product_name)} × ${Number(i.quantity||0)}</span><b>${money(Number(i.price||0)*Number(i.quantity||0))}</b></div>`).join('');card.innerHTML=`<div class=\"tracking-title\">Ваш заказ</div><div class=\"tracking-id\">${esc(o.external_id||'')}</div>${pipeline}<div class=\"tracking-items\">${items}<div class=\"total\" style=\"padding-bottom:0\"><span>Итого</span><span>${money(o.total)}</span></div></div><div class=\"tracking-actions\"><button class=\"primary\" onclick=\"loadTracking(true)\">Обновить</button><button onclick=\"hideTracking()\">Скрыть</button></div>`;if(o.status==='ready'){clearInterval(trackingTimer);trackingTimer=null;}}";
    if (!html.includes(oldRender)) throw new Error("Tracking render function not found");
    html = html.replace(oldRender, newRender);
    res.type("html").send(html);
  } catch (error) {
    console.error("GET / tracking override:", error);
    res.status(500).send("Не удалось загрузить меню");
  }
});

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

// Once a day remove ready orders that have already been kept for 24 hours.
// Delete child rows explicitly so cleanup works regardless of FK cascade setup.
async function cleanupReadyOrders() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: oldOrders, error: selectError } = await supabase.from("orders").select("id").eq("status", "ready").lt("updated_at", cutoff).limit(500);
    if (selectError) throw selectError;
    const ids = (oldOrders || []).map(order => order.id);
    if (!ids.length) return;
    const { error: itemsError } = await supabase.from("order_items").delete().in("order_id", ids);
    if (itemsError) throw itemsError;
    const { error: ordersError } = await supabase.from("orders").delete().in("id", ids).eq("status", "ready");
    if (ordersError) throw ordersError;
    console.log(`Daily cleanup removed ${ids.length} ready orders`);
  } catch (error) {
    console.error("Daily ready-order cleanup:", error);
  }
}
setTimeout(cleanupReadyOrders, 60 * 1000);
setInterval(cleanupReadyOrders, 24 * 60 * 60 * 1000);
