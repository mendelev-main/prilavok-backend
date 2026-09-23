import { createHash, timingSafeEqual } from 'node:crypto';

export const OWNER_TTL = 10 * 60 * 1000;
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const same = (a,b) => typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const fail = (message,status=409) => { const e=new Error(message);e.status=status;throw e; };
const validId = s => typeof s==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(s);
const validSecret = s => typeof s==='string' && /^[A-Za-z0-9_-]{32,64}$/.test(s);
export function ownerBotAuthorized(value,secret){return validSecret(secret)&&same(value,secret);}
export function ownerConfiguration(env=process.env) {
  return {enabled:env.OWNER_AUTH_ENABLED==='true',deviceId:env.OWNER_PRIMARY_DEVICE_ID,
    bootstrapTelegramId:env.OWNER_BOOTSTRAP_TELEGRAM_ID,botUsername:env.OWNER_BOT_USERNAME,
    botSecret:env.OWNER_BOT_SHARED_SECRET,botToken:env.TELEGRAM_BOT_TOKEN,
    reportChatId:env.POS_REPORT_CHAT_ID,reportThreadId:env.POS_REPORT_THREAD_ID,venue:env.OWNER_VENUE_NAME||'M POS'};
}
export function createOwnerService({store,config,now=Date.now}) {
  function ready(){if(!config.enabled||!config.deviceId||!/^\d{1,20}$/.test(config.bootstrapTelegramId||'')||!validSecret(config.botSecret)||!/^\w{5,32}$/.test(config.botUsername||''))fail('Привязка владельца ещё не настроена на сервере',503);}
  async function change(fn){
    ready();
    for(let attempt=0;attempt<8;attempt++){
      const {revision,document}=await store.read();const state=structuredClone(document);
      state.sessions||={};state.audit||=[];
      // Keep consumed responses for interrupted native Keychain writes; epoch prevents old recovery replay.
      for(const [id,s] of Object.entries(state.sessions))if(now()>(s.completedAt?s.completedAt+86400000:s.expires))delete state.sessions[id];
      const result=fn(state);
      if(await store.cas(revision,state))return result;
    }
    fail('Повторите действие: одновременно выполнялась другая операция',409);
  }
  function session(state,input){const s=state.sessions[input.id];if(!s||!same(s.proof,hash(input.secret||''))||s.installationId!==input.installationId)fail('Запрос не найден',404);if(s.state!=='consumed'&&s.expires<=now())fail('Срок запроса истёк',410);return s;}
  function publicSession(s){return {id:s.id,status:s.state,kind:s.kind,expiresAt:s.expires,telegramName:s.telegramName||'',telegramId:s.telegramId||''};}
  function audit(state,action,s){state.audit.push({at:now(),action,employeeId:s.employeeId,installationId:s.installationId,telegramId:s.telegramId||null});}
  return {
    async start(input){
      ready();if(!validId(input.id)||!validId(input.installationId)||!validId(input.employeeId)||!validSecret(input.secret)||!(/^[A-Za-z0-9_-]{43}$/.test(input.token||''))||!['bind','recover'].includes(input.kind)||typeof input.name!=='string'||!input.name.trim()||input.name.length>120)fail('Некорректный запрос',400);
      return change(state=>{
        const old=state.sessions[input.id];if(old){const s=session(state,input);if((s.requestedKind||s.kind)!==input.kind||s.link!==hash(input.token)||s.employeeId!==input.employeeId)fail('Запрос уже существует');return {...publicSession(s),telegramUrl:`https://t.me/${config.botUsername}?start=owner_${input.token}`};}
        if(input.kind==='bind'&&state.owner&&(state.owner.installationId!==input.installationId||state.owner.employeeId!==input.employeeId))fail('Владелец уже зарегистрирован');
        if(input.kind==='recover'&&(!state.owner||state.owner.installationId!==input.installationId||state.owner.employeeId!==input.employeeId))fail('Владелец на этом устройстве не найден',403);
        state.starts=(state.starts||[]).filter(t=>t>now()-3600000);if(state.starts.length>=6)fail('Слишком много запросов. Повторите позже',429);
        state.starts.push(now());
        // Starting another request invalidates older unconsumed requests for this installation.
        for(const s of Object.values(state.sessions))if(s.installationId===input.installationId&&s.state!=='consumed')s.state='cancelled';
        const s={id:input.id,installationId:input.installationId,employeeId:input.employeeId,name:state.owner?.name||input.name.trim(),requestedKind:input.kind,kind:state.owner?'recover':'bind',proof:hash(input.secret),link:hash(input.token),createdAt:now(),expires:now()+OWNER_TTL,state:'pending',epoch:state.owner?.epoch||0,expectedTelegramId:state.owner?.telegramId||config.bootstrapTelegramId};state.sessions[s.id]=s;
        return {...publicSession(s),telegramUrl:`https://t.me/${config.botUsername}?start=owner_${input.token}`};
      });
    },
    async bot(input){
      if(!validSecret(input.token)||!/^\d{1,20}$/.test(input.telegramId||''))fail('Недействительный запрос',400);
      return change(state=>{
        const s=Object.values(state.sessions).find(s=>same(s.link,hash(input.token)));
        if(!s||s.expires<=now()||!['pending','approved'].includes(s.state))fail('Ссылка недействительна или уже использована',410);
        if(s.expectedTelegramId!==input.telegramId)fail('Этот запрос доступен только владельцу кассы',403);
        if(input.action==='approve'){s.state='approved';s.telegramId=input.telegramId;s.telegramName=String(input.name||'Telegram').slice(0,120);}
        else if(input.action==='deny'){s.state='cancelled';audit(state,'denied',s);}
        else if(input.action!=='lookup')fail('Неизвестное действие',400);
        return {...publicSession(s),venue:config.venue,employeeName:s.name};
      });
    },
    async status(input){return change(state=>publicSession(session(state,input)));},
    async cancel(input){return change(state=>{const s=session(state,input);if(s.state==='consumed')fail('Операция уже завершена');s.state='cancelled';return {ok:true};});},
    async finish(input){return change(state=>{
      const s=session(state,input);
      if(s.state==='consumed'){if(state.owner?.epoch!==s.grant.epoch)fail('Подтверждение уже заменено новым');return {owner:s.grant};}
      if(s.state!=='approved')fail('Сначала подтвердите запрос в Telegram');
      if(s.kind==='bind'&&state.owner)fail('Владелец уже зарегистрирован');
      if(s.kind==='recover'&&(!state.owner||state.owner.epoch!==s.epoch||state.owner.installationId!==s.installationId||state.owner.telegramId!==s.telegramId))fail('Подтверждение устарело');
      const owner={employeeId:s.employeeId,name:s.name,installationId:s.installationId,telegramId:s.telegramId,telegramName:s.telegramName,epoch:s.epoch+1};
      state.owner=owner;s.state='consumed';s.completedAt=now();s.grant=owner;audit(state,s.kind,s);return {owner};
    });}
  };
}
export function supabaseOwnerStore(db){return {
  async read(){const {data,error}=await db.from('owner_auth_state').select('revision,document').eq('id',true).single();if(error)throw error;return data;},
  async cas(revision,document){const {data,error}=await db.rpc('owner_auth_compare_swap',{expected_revision:revision,next_document:document});if(error)throw error;return data===true;}
};}
export function mountOwnerRoutes(app,{db,config=ownerConfiguration(),fetchImpl=fetch}){
  const service=createOwnerService({store:supabaseOwnerStore(db),config});
  const wrap=fn=>async(req,res)=>{res.setHeader('Cache-Control','no-store');try{res.json(await fn(req));}catch(e){res.status(e.status||503).json({error:e.status?e.message:'Сервис владельца временно недоступен'});}};
  async function device(req){
    if(!config.enabled||!config.deviceId)fail('Сервис владельца не настроен',503);
    const key=req.header('x-device-key');if(typeof key!=='string'||key.length<16||key.length>200)fail('Устройство не подтверждено',401);
    const {data,error}=await db.from('devices').select('id').eq('id',config.deviceId).eq('device_key',key).eq('is_active',true).maybeSingle();
    if(error)throw error;if(!data)fail('Устройство не подтверждено',403);
  }
  for(const action of ['start','status','finish','cancel'])app.post(`/api/owner/${action}`,wrap(async req=>{await device(req);return service[action](req.body||{});}));
  app.post('/api/owner/bot',wrap(async req=>{
    if(!ownerBotAuthorized(req.header('x-owner-bot-secret'),config.botSecret))fail('Доступ запрещён',403);
    return service.bot(req.body||{});
  }));
  // Fixed recipient on server; clients cannot turn this into an arbitrary Telegram relay.
  let reportRequests=[];
  app.post('/api/owner/report',wrap(async req=>{
    await device(req);if(!config.botToken||!config.reportChatId)fail('Получатель отчётов не настроен',503);
    reportRequests=reportRequests.filter(at=>at>Date.now()-60000);if(reportRequests.length>=12)fail('Слишком много отчётов. Повторите через минуту',429);reportRequests.push(Date.now());
    let body;let method;
    if(req.body?.photo){
      const photo=String(req.body.photo);if(photo.length>13400000||!/^[A-Za-z0-9+/]+=*$/.test(photo))fail('Некорректный отчёт',400);
      body=new FormData();body.set('chat_id',config.reportChatId);if(config.reportThreadId)body.set('message_thread_id',config.reportThreadId);body.set('photo',new Blob([Buffer.from(photo,'base64')],{type:'image/png'}),'shift.png');body.set('caption',String(req.body.caption||'').slice(0,1000));body.set('parse_mode','HTML');method='sendPhoto';
    }else{
      const text=String(req.body?.text||'');if(!text||text.length>4000)fail('Некорректный отчёт',400);
      body=JSON.stringify({chat_id:config.reportChatId,message_thread_id:config.reportThreadId||undefined,text,parse_mode:'HTML'});method='sendMessage';
    }
    const response=await fetchImpl(`https://api.telegram.org/bot${config.botToken}/${method}`,{method:'POST',headers:typeof body==='string'?{'Content-Type':'application/json'}:undefined,body,signal:AbortSignal.timeout(15000)});
    if(!response.ok||!(await response.json()).ok)fail('Telegram не принял отчёт',502);return {ok:true};
  }));
  return service;
}
