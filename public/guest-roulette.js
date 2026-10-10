(function(){
  'use strict';
  const reduceMotion=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const productPrice=value=>Number(value||0).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' BYN';
  const positiveAngle=angle=>((angle%360)+360)%360;
  const angleIndex=(angle,count)=>count>0?Math.floor(positiveAngle(-angle+180/count)/(360/count))%count:0;
  const targetAngle=(start,index,count)=>start+5*360+positiveAngle(-index*360/count-start);
  const spinFrame=(start,end,elapsed,duration=6000)=>{const t=Math.max(0,Math.min(1,elapsed/duration));return {angle:start+(end-start)*(1-Math.pow(1-t,4)),done:t===1};};
  const randomDuration=()=>{const values=new Uint32Array(1);if(globalThis.crypto?.getRandomValues)globalThis.crypto.getRandomValues(values);else values[0]=Math.floor(Math.random()*0xffffffff);return 4000+values[0]%4001;};
  const randomItem=(items,lastId)=>{
    const candidates=items.length>1?items.filter(item=>String(item.id)!==String(lastId)):items;
    const values=new Uint32Array(1);
    if(globalThis.crypto?.getRandomValues)globalThis.crypto.getRandomValues(values);else values[0]=Math.floor(Math.random()*0xffffffff);
    return candidates[values[0]%candidates.length];
  };
  function mount(options){
    const launch=document.getElementById('rouletteLaunch');if(!launch||!options)return;
    const overlay=document.createElement('div');overlay.className='roulette-overlay';overlay.setAttribute('aria-hidden','true');
    overlay.innerHTML='<div class="roulette-dialog" role="dialog" aria-modal="true" aria-labelledby="rouletteTitle" aria-describedby="rouletteDescription"><button class="roulette-close" type="button" aria-label="Закрыть">×</button><div class="roulette-heading"><h2 id="rouletteTitle">Рулетка</h2><p id="rouletteDescription">Выберите категорию — мы предложим случайный доступный товар.</p></div><label class="roulette-label" for="rouletteCategory">Категория</label><div class="roulette-select-wrap"><select id="rouletteCategory" class="roulette-select"></select></div><div class="roulette-stage"><span class="roulette-pointer" aria-hidden="true"></span><div class="roulette-wheel" aria-hidden="true"></div><div class="roulette-readout" aria-live="polite"><span class="roulette-readout-label">Ваш выбор</span><strong>Готовы?</strong><small>Нажмите «Крутить»</small></div></div><div class="roulette-actions"><button class="roulette-spin" type="button">Крутить</button><button class="roulette-view" type="button" hidden>Открыть товар</button></div></div>';
    document.body.appendChild(overlay);
    const dialog=overlay.querySelector('.roulette-dialog'),closeButton=overlay.querySelector('.roulette-close'),categorySelect=overlay.querySelector('.roulette-select'),wheel=overlay.querySelector('.roulette-wheel'),readout=overlay.querySelector('.roulette-readout'),spinButton=overlay.querySelector('.roulette-spin'),viewButton=overlay.querySelector('.roulette-view'),actions=overlay.querySelector('.roulette-actions');
    let result=null,lastProductId=null,frameId=null,generation=0,angle=0,previousOverflow='';
    const productsFor=categoryId=>(options.getProducts?.()||[]).filter(product=>String(product.category_id)===String(categoryId)&&options.isAvailable(product));
    const cancelSpin=()=>{generation++;if(frameId!==null)cancelAnimationFrame(frameId);frameId=null;readout.setAttribute('aria-live','polite');};
    const buildWheel=items=>{
      const step=360/Math.max(1,items.length),colors=['#ef765e','#343943','#d95643','#272b32'];
      wheel.style.background=items.length?'conic-gradient(from '+(-step/2)+'deg,'+items.map((_,i)=>colors[i%colors.length]+' '+(i*step)+'deg '+((i+1)*step)+'deg').join(',')+')':'';
      const labelStep=Math.ceil(items.length/12)||1;
      wheel.innerHTML=items.map((_,i)=>i%labelStep?'':'<span class="roulette-sector" data-sector="'+i+'" style="--sector-angle:'+(i*step)+'deg">'+(i+1)+'</span>').join('');
      wheel.style.transform='rotate('+angle+'deg)';
    };
    const resetResult=()=>{cancelSpin();result=null;angle=0;viewButton.hidden=true;actions.classList.remove('has-result');spinButton.textContent='Крутить';spinButton.disabled=false;categorySelect.disabled=false;readout.innerHTML='<span class="roulette-readout-label">Ваш выбор</span><strong>Готовы?</strong><small>Нажмите «Крутить»</small>';buildWheel(productsFor(categorySelect.value));};
    const populateCategories=()=>{
      const categories=(options.getCategories?.()||[]).filter(category=>productsFor(category.id).length>0);
      categorySelect.innerHTML=categories.map(category=>'<option value="'+escapeHtml(category.id)+'">'+escapeHtml(category.name)+'</option>').join('');
      const preferred=String(options.getActiveCategoryId?.()??'');if(categories.some(category=>String(category.id)===preferred))categorySelect.value=preferred;
      const hasCategories=categories.length>0;categorySelect.disabled=!hasCategories;spinButton.disabled=!hasCategories;buildWheel(productsFor(categorySelect.value));
      if(!hasCategories)readout.innerHTML='<strong>Нет доступных товаров</strong><small>Попробуйте позже</small>';return hasCategories;
    };
    const open=()=>{resetResult();populateCategories();previousOverflow=document.body.style.overflow;overlay.classList.add('is-open');overlay.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';closeButton.focus();};
    const close=()=>{cancelSpin();overlay.classList.remove('is-open');overlay.setAttribute('aria-hidden','true');document.body.style.overflow=previousOverflow;launch.focus();};
    const showItem=(item,index,finished=false)=>{wheel.querySelectorAll('[data-sector]').forEach(label=>label.classList.toggle('is-active',Number(label.dataset.sector)===index));readout.dataset.sector=String(index);readout.innerHTML='<span class="roulette-readout-label">'+(finished?'Попробуйте':'Под указателем')+' · '+(index+1)+'</span><strong>'+escapeHtml(item.name)+'</strong><small>'+escapeHtml(productPrice(item.price))+'</small>';};
    const finish=(selected,index)=>{
      frameId=null;readout.setAttribute('aria-live','polite');categorySelect.disabled=false;spinButton.disabled=false;spinButton.textContent='Крутить ещё';
      result=productsFor(categorySelect.value).find(item=>String(item.id)===String(selected.id));
      if(!result){viewButton.hidden=true;readout.innerHTML='<strong>Товар закончился</strong><small>Крутите ещё, чтобы выбрать другой</small>';return;}
      lastProductId=result.id;showItem(result,index,true);viewButton.hidden=false;actions.classList.add('has-result');
    };
    const spin=()=>{
      if(spinButton.disabled)return;const items=productsFor(categorySelect.value);if(!items.length){populateCategories();return;}
      cancelSpin();const selected=randomItem(items,lastProductId),index=items.indexOf(selected),start=angle,end=targetAngle(start,index,items.length),duration=randomDuration(),run=generation;
      result=null;viewButton.hidden=true;actions.classList.remove('has-result');spinButton.disabled=true;categorySelect.disabled=true;spinButton.textContent='Выбираем…';buildWheel(items);readout.setAttribute('aria-live','off');
      if(reduceMotion()){angle=end;wheel.style.transform='rotate('+angle+'deg)';finish(selected,index);return;}
      let started=null,visibleIndex=-1;
      const tick=now=>{if(run!==generation)return;if(started===null)started=now;const frame=spinFrame(start,end,now-started,duration);angle=frame.angle;wheel.style.transform='rotate('+angle+'deg)';const current=angleIndex(angle,items.length);if(current!==visibleIndex){visibleIndex=current;showItem(items[current],current);}if(frame.done){finish(selected,index)}else frameId=requestAnimationFrame(tick);};
      frameId=requestAnimationFrame(tick);
    };
    launch.addEventListener('click',open);closeButton.addEventListener('click',close);overlay.addEventListener('click',event=>{if(event.target===overlay)close()});categorySelect.addEventListener('change',resetResult);spinButton.addEventListener('click',spin);
    viewButton.addEventListener('click',()=>{if(!result)return;const selected=productsFor(categorySelect.value).find(item=>String(item.id)===String(result.id));if(!selected){resetResult();populateCategories();return;}close();options.onSelect?.(selected);});
    document.addEventListener('keydown',event=>{if(!overlay.classList.contains('is-open'))return;if(event.key==='Escape')close();if(event.key==='Tab'){const controls=[...dialog.querySelectorAll('button:not([disabled]),select:not([disabled])')].filter(node=>!node.hidden),first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}});
  }
  window.GuestRoulette={mount,motion:{angleIndex,targetAngle,spinFrame,randomDuration}};
})();
