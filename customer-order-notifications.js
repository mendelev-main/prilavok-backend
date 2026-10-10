// Delivery acknowledgement is not idempotent in Telegram. Never retry an ambiguous send.
export async function deliverCreatedOrder({botToken,chatId,externalId,fetchImpl=fetch}) {
  const text=`<b>Заказ №${String(externalId||'').slice(0,8).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</b>\n⚪️ Статус: <b>Создан</b>\n\nОтправили ваш заказ в заведение. Сообщим, когда его статус изменится.`;
  try {
    const response=await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML',disable_web_page_preview:true}),signal:AbortSignal.timeout(10_000)});
    const body=await response.json().catch(()=>null);
    if(response.ok&&body?.ok===true&&Number.isInteger(body.result?.message_id))return {state:'sent',messageId:body.result.message_id};
    if(body?.ok===false&&Number.isInteger(body.error_code)) {
      if(body.error_code===429||body.error_code>=500)return {state:'retry',retrySeconds:Math.min(86400,Math.max(30,Math.ceil(Number(body.parameters?.retry_after))||30))};
      return {state:'rejected'};
    }
    return {state:'uncertain'};
  } catch {return {state:'uncertain'};}
}

export function createCustomerOrderNotificationWorker({supabase,botToken,isSleeping=()=>false,fetchImpl=fetch,logger=console}) {
  let busy=false;
  async function rpc(name,args) {
    const response=await supabase.rpc(name,args).abortSignal(AbortSignal.timeout(10_000));
    if(response.error)throw Error('notification_database_error');
    return response.data;
  }
  return async function poll() {
    if(busy||!botToken||isSleeping())return;
    busy=true;
    try {
      // Claim one at a time so waiting rows cannot lose their lease during a slow batch.
      for(let i=0;i<10;i++) {
        const rows=await rpc('claim_customer_order_notification',{}),job=rows?.[0];
        if(!job)break;
        const outcome=await deliverCreatedOrder({botToken,chatId:job.chat_id,externalId:job.external_id,fetchImpl});
        const saved=await rpc('finish_customer_order_notification',{p_order_id:job.order_id,p_token:job.claim_token,p_state:outcome.state,p_message_id:outcome.messageId??null,p_retry_seconds:outcome.retrySeconds??30});
        if(saved!==true)throw Error('notification_state_not_saved');
        if(outcome.state!=='sent')logger.warn('Customer order notification outcome',{state:outcome.state});
      }
    } catch {logger.error('Customer order notification worker failed; claimed deliveries are not automatically resent');}
    finally {busy=false;}
  };
}
