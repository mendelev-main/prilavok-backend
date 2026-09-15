(function(root){
  'use strict';
  function normalizePhone(value){
    const raw=String(value||'').trim();
    if(!/^\+375[\d\s()-]+$/.test(raw))return '';
    const phone=raw.replace(/[\s()-]/g,'');
    return /^\+375\d{9}$/.test(phone)?phone:'';
  }
  function hasProfanity(value){
    const words=String(value||'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[\u200b-\u200d\ufeff]/g,'').match(/[а-яa-z]+/g)||[];
    return words.some(word=>/^(?:(?:на|по|ни|за)?хуй[а-я]*|ху[еяи][а-я]*|пизд[а-я]*|(?:за|вы|на|от|до|пере|по)?еб(?:а|у|и|л|н|о)[а-я]*|бля(?:д[а-я]*|ть|ха)?|сука|суки|суку|сукой|сукам|суками|суках|мудак[а-я]*|мудил[а-я]*|гандон[а-я]*|говно[а-я]*|дерьм[а-я]*|fuck[a-z]*|shit|bullshit|bitch(?:es)?|asshole[s]?|blyat|blyad|pizd[a-z]*|khuy|huy)$/.test(word));
  }
  function validate(data){
    if(!normalizePhone(data.phone))return 'Введите телефон: +375 и 9 цифр номера.';
    if(hasProfanity(data.comment)||(Array.isArray(data.items)&&data.items.some(item=>hasProfanity(item?.comment))))return 'Уберите нецензурные слова из комментария.';
    return '';
  }
  root.OrderValidation=Object.freeze({normalizePhone,hasProfanity,validate});

  if(typeof window==='undefined'||typeof document==='undefined')return;

  const CHECKOUT_KEY='project_checkout_session';
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function readSession(){try{return JSON.parse(localStorage.getItem(CHECKOUT_KEY)||'null')}catch(_){return null}}
  function saveSession(value){try{localStorage.setItem(CHECKOUT_KEY,JSON.stringify(value))}catch(_){}}
  function clearSession(){try{localStorage.removeItem(CHECKOUT_KEY)}catch(_){}}
  function buildCheckoutData(){
    const delivery=orderType==='Доставка';
    return {orderType,customerName:(document.getElementById(delivery?'name':'namePickup').value||'').trim(),phone:'+375'+(document.getElementById(delivery?'phone':'phonePickup').value||'').trim(),address:delivery?(document.getElementById('address').value||'').trim():'',comment:(document.getElementById(delivery?'comment':'commentPickup').value||'').trim(),items:cart.map(x=>({productId:x.id,quantity:x.qty,comment:null}))};
  }
  function checkoutToken(){const url=new URL(location.href);return url.searchParams.get('checkout')||readSession()?.token||''}
  async function waitForCheckout(token){
    if(!token)return;
    const deadline=Date.now()+6*60*1000;toast('Проверяем заказ…');
    while(Date.now()<deadline){
      try{
        const r=await fetch(API+'/api/checkout/'+encodeURIComponent(token),{cache:'no-store'});const j=await r.json();
        if(r.ok&&j.status==='ORDER_CREATED'&&j.trackingToken){clearSession();location.replace('/?order='+encodeURIComponent(j.trackingToken));return}
        if(j.status==='EXPIRED'){clearSession();toast('Время подтверждения истекло. Оформите заказ ещё раз.');return}
      }catch(_){}
      await sleep(1200);
    }
  }
  async function verifiedSubmitOrder(){
    if(!cart.length)return;
    const data=buildCheckoutData();const delivery=data.orderType==='Доставка';
    if(!data.customerName||!data.phone||(delivery&&!data.address)){toast('Заполните имя, телефон и адрес для доставки');return}
    const validationError=validate(data);if(validationError){toast(validationError);return}
    data.phone=normalizePhone(data.phone);const btn=document.getElementById('submitBtn');btn.disabled=true;btn.textContent='Открываем Telegram…';
    try{const r=await fetch(API+'/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const j=await r.json();if(!r.ok)throw new Error(j.error||'Не удалось начать оформление');saveSession({token:j.checkoutToken,expiresAt:j.expiresAt});location.href=j.telegramUrl}
    catch(e){toast(e.message||'Не удалось открыть подтверждение');btn.disabled=false;btn.textContent='Оформить заказ'}
  }
  async function loadOrderByTrackingToken(token,scroll){
    if(!token)return null;
    const r=await fetch(API+'/api/orders/'+encodeURIComponent(token),{cache:'no-store'});
    if(r.status===404)return null;
    const j=await r.json();if(!r.ok)throw new Error(j.error||'Ошибка');
    trackingOrder=j.order;renderTracking(j.order);
    if(scroll)document.getElementById('trackingCard')?.scrollIntoView({behavior:'smooth',block:'start'});
    return j.order;
  }
  async function correctedLoadTracking(scroll){
    if(!trackingToken)return;
    try{
      const order=await loadOrderByTrackingToken(trackingToken,scroll);
      if(!order){
        trackingOrder=null;
        const card=document.getElementById('trackingCard');if(card)card.innerHTML='<div class="muted">Заказ не найден.</div>';
        return;
      }
    }catch(_){
      if(scroll){if(!trackingOrder){const card=document.getElementById('trackingCard');if(card)card.innerHTML='<div class="muted">Не удалось загрузить заказ. Закройте и откройте блок, чтобы повторить.</div>'}toast('Не удалось загрузить статус заказа')}
    }
  }
  async function loadReturnedOrder(token){
    if(!token)return false;
    try{
      const order=await loadOrderByTrackingToken(token,false);if(!order)return false;
      trackingToken=String(token).trim();
      try{localStorage.setItem('prilavok_tracking_token',trackingToken)}catch(_){}
      const card=document.getElementById('trackingCard');if(card){card.hidden=false;card.style.display='block'}
      document.getElementById('trackingLink')?.setAttribute('aria-expanded','true');
      clearInterval(trackingTimer);trackingTimer=setInterval(()=>correctedLoadTracking(false),2500);
      return true;
    }catch(_){return false}
  }

  window.addEventListener('load',async()=>{
    window.submitOrder=verifiedSubmitOrder;
    window.loadTracking=correctedLoadTracking;
    const url=new URL(location.href);const returnedOrder=url.searchParams.get('order');
    if(returnedOrder){
      const ok=await loadReturnedOrder(returnedOrder);
      if(ok){url.searchParams.delete('order');history.replaceState({},'',url.pathname+(url.searchParams.toString()?'?'+url.searchParams.toString():'')+url.hash);return}
    }
    const token=checkoutToken();if(token)waitForCheckout(token);
  });
})(globalThis);
