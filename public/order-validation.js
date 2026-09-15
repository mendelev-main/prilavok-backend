(function(root){
  'use strict';
  function normalizePhone(value){
    const raw=String(value||'').trim();
    if(!/^\+375[\d\s()-]+$/.test(raw))return '';
    const phone=raw.replace(/[\s()-]/g,'');
    return /^\+375\d{9}$/.test(phone)?phone:'';
  }
  // Whole words and common inflections; avoid substring matches in ordinary words.
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

  const PENDING_KEY='project_phone_verification_checkout';
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

  function readPending(){
    try{return JSON.parse(localStorage.getItem(PENDING_KEY)||'null')}catch(_){return null}
  }
  function savePending(value){localStorage.setItem(PENDING_KEY,JSON.stringify(value))}
  function clearPending(){localStorage.removeItem(PENDING_KEY)}
  function cleanReturnUrl(){
    const url=new URL(location.href);
    url.searchParams.delete('verification');
    return url.toString();
  }
  function currentVerificationToken(){
    const fromUrl=new URL(location.href).searchParams.get('verification');
    return fromUrl||readPending()?.token||'';
  }
  function buildCheckoutData(){
    const delivery=orderType==='Доставка';
    return {
      orderType,
      customerName:(document.getElementById(delivery?'name':'namePickup').value||'').trim(),
      phone:'+375'+(document.getElementById(delivery?'phone':'phonePickup').value||'').trim(),
      address:delivery?(document.getElementById('address').value||'').trim():'',
      comment:(document.getElementById(delivery?'comment':'commentPickup').value||'').trim(),
      items:cart.map(x=>({productId:x.id,quantity:x.qty,comment:null})),
    };
  }
  async function createOrderAfterVerification(pending){
    const data={...pending.order,verificationToken:pending.token};
    const r=await fetch(API+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'Не удалось создать заказ');
    clearPending();
    const url=new URL(location.href);url.searchParams.delete('verification');history.replaceState({},'',url.pathname+url.search+url.hash);
    saveTrackingToken(j.trackingToken);
    closeCart();
    document.getElementById('successModal').style.display='flex';
  }
  async function waitForVerification(token){
    let pending=readPending();
    if(!pending||pending.token!==token){toast('Вернитесь к заказу в том браузере, где вы его оформляли.');return}
    const deadline=Date.parse(pending.expiresAt||'')||Date.now()+5*60*1000;
    toast('Проверяем подтверждение номера…');
    while(Date.now()<deadline){
      try{
        const r=await fetch(API+'/api/phone-verification/'+encodeURIComponent(token),{cache:'no-store'});
        const j=await r.json();
        if(r.ok&&j.status==='VERIFIED'){
          await createOrderAfterVerification(pending);
          return;
        }
        if(j.status==='EXPIRED'||j.status==='CONSUMED')break;
      }catch(_){}
      await sleep(1200);
    }
    clearPending();
    toast('Время подтверждения истекло. Попробуйте ещё раз.');
  }
  async function verifiedSubmitOrder(){
    if(!cart.length)return;
    const data=buildCheckoutData();
    const delivery=data.orderType==='Доставка';
    if(!data.customerName||!data.phone||(delivery&&!data.address)){toast('Заполните имя, телефон и адрес для доставки');return}
    const validationError=validate(data);if(validationError){toast(validationError);return}
    data.phone=normalizePhone(data.phone);
    const btn=document.getElementById('submitBtn');btn.disabled=true;btn.textContent='Открываем Telegram…';
    try{
      const r=await fetch(API+'/api/phone-verification',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:data.phone,returnUrl:cleanReturnUrl()})});
      const j=await r.json();if(!r.ok)throw new Error(j.error||'Не удалось начать подтверждение');
      savePending({token:j.token,expiresAt:j.expiresAt,order:data});
      location.href=j.telegramUrl;
    }catch(e){toast(e.message||'Не удалось открыть подтверждение');btn.disabled=false;btn.textContent='Оформить заказ'}
  }

  window.addEventListener('load',()=>{
    window.submitOrder=verifiedSubmitOrder;
    const token=currentVerificationToken();
    if(token)waitForVerification(token);
  });
})(globalThis);
