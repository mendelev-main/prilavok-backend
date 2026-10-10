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
  const drumIndex=(position,count)=>count>0?((Math.round(position)%count)+count)%count:0;
  const drumTarget=(start,index,count)=>Math.ceil(start)+count*5+((index-Math.ceil(start)%count+count)%count);
  const randomItem=(items,lastId)=>{
    const candidates=items.length>1?items.filter(item=>String(item.id)!==String(lastId)):items;
    const values=new Uint32Array(1);
    if(globalThis.crypto?.getRandomValues)globalThis.crypto.getRandomValues(values);else values[0]=Math.floor(Math.random()*0xffffffff);
    return candidates[values[0]%candidates.length];
  };
  function mount(options){
    const launch=document.getElementById('rouletteLaunch');if(!launch||!options)return;
    const overlay=document.createElement('div');overlay.className='roulette-overlay';overlay.setAttribute('aria-hidden','true');
    overlay.innerHTML='<div class="roulette-dialog" role="dialog" aria-modal="true" aria-labelledby="rouletteTitle"><button class="roulette-close" type="button" aria-label="Закрыть">×</button><div class="roulette-heading"><h2 id="rouletteTitle">Барабан товаров</h2></div><label class="roulette-label" for="rouletteCategory">Категория</label><div class="roulette-select-wrap"><select id="rouletteCategory" class="roulette-select"></select></div><div class="roulette-stage"><div class="roulette-wheel" aria-hidden="true"></div><div class="roulette-selection" aria-hidden="true"></div></div><div class="roulette-readout" aria-live="polite"></div><div class="roulette-actions"><button class="roulette-spin" type="button">Крутить</button><button class="roulette-view" type="button" hidden>Открыть товар</button></div></div>';
    document.body.appendChild(overlay);
    const dialog=overlay.querySelector('.roulette-dialog'),closeButton=overlay.querySelector('.roulette-close'),categorySelect=overlay.querySelector('.roulette-select'),wheel=overlay.querySelector('.roulette-wheel'),readout=overlay.querySelector('.roulette-readout'),spinButton=overlay.querySelector('.roulette-spin'),viewButton=overlay.querySelector('.roulette-view'),actions=overlay.querySelector('.roulette-actions');
    let result=null,lastProductId=null,frameId=null,generation=0,angle=0,previousOverflow='',drumRows=[],drumItems=[];
    const productsFor=categoryId=>(options.getProducts?.()||[]).filter(product=>String(product.category_id)===String(categoryId)&&options.isAvailable(product));
    const cancelSpin=()=>{generation++;if(frameId!==null)cancelAnimationFrame(frameId);frameId=null;readout.setAttribute('aria-live','polite');};
    const renderDrum=position=>{
      const base=Math.floor(position),fraction=position-base,count=drumItems.length;
      if(!count){drumRows.forEach(row=>{row.innerHTML="";row.style.transform="none";});return;}
      drumRows.forEach((row,slot)=>{
        const offset=slot-2,index=((base+offset)%count+count)%count,item=drumItems[index];
        row.style.transform='translateY('+((offset-fraction)*112)+'px)';
        row.classList.toggle('is-current',index===drumIndex(position,count));
        if(!item){row.innerHTML='';return;}
        if(row.dataset.productId!==String(item.id)){
          row.dataset.productId=String(item.id);
          const image=typeof item.image_url==='string'&&/^(https?:\/\/|\/[^/])/.test(item.image_url)?'<img src="'+escapeHtml(item.image_url)+'" alt="" decoding="async">':'<span class="roulette-photo-placeholder" aria-hidden="true">—</span>';
          row.innerHTML='<div class="roulette-photo">'+image+'</div><div class="roulette-product-copy"><strong>'+escapeHtml(item.name)+'</strong><small>'+escapeHtml(productPrice(item.price))+'</small></div>';
        }
      });
    };
    const buildWheel=items=>{
      drumItems=items;wheel.innerHTML=Array.from({length:5},()=>'<div class="roulette-drum-row"></div>').join('');
      drumRows=[...wheel.children];renderDrum(angle);
    };
    const resetResult=()=>{cancelSpin();result=null;angle=0;viewButton.hidden=true;actions.classList.remove('has-result');spinButton.textContent='Крутить';spinButton.disabled=false;categorySelect.disabled=false;readout.classList.remove('is-error');readout.innerHTML='';buildWheel(productsFor(categorySelect.value));};
    const populateCategories=()=>{
      const categories=(options.getCategories?.()||[]).filter(category=>productsFor(category.id).length>0);
      categorySelect.innerHTML=categories.map(category=>'<option value="'+escapeHtml(category.id)+'">'+escapeHtml(category.name)+'</option>').join('');
      const preferred=String(options.getActiveCategoryId?.()??'');if(categories.some(category=>String(category.id)===preferred))categorySelect.value=preferred;
      const hasCategories=categories.length>0;categorySelect.disabled=!hasCategories;spinButton.disabled=!hasCategories;buildWheel(productsFor(categorySelect.value));
      if(!hasCategories){readout.classList.add('is-error');readout.innerHTML='<strong>Нет доступных товаров</strong><small>Попробуйте позже</small>';}return hasCategories;
    };
    const open=()=>{resetResult();populateCategories();previousOverflow=document.body.style.overflow;overlay.classList.add('is-open');overlay.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';closeButton.focus();};
    const close=()=>{cancelSpin();overlay.classList.remove('is-open');overlay.setAttribute('aria-hidden','true');document.body.style.overflow=previousOverflow;launch.focus();};
    const showItem=(item,index,finished=false)=>{readout.dataset.sector=String(index);readout.innerHTML='<span class="roulette-readout-label">'+(finished?'Ваш выбор':'Выбираем товар')+'</span><strong>'+escapeHtml(item.name)+'</strong><small>'+escapeHtml(productPrice(item.price))+'</small>';};
    const finish=(selected,index)=>{
      frameId=null;readout.setAttribute('aria-live','polite');categorySelect.disabled=false;spinButton.disabled=false;spinButton.textContent='Крутить ещё';
      result=productsFor(categorySelect.value).find(item=>String(item.id)===String(selected.id));
      if(!result){viewButton.hidden=true;readout.classList.add('is-error');readout.innerHTML='<strong>Товар закончился</strong><small>Крутите ещё, чтобы выбрать другой</small>';return;}
      lastProductId=result.id;showItem(result,index,true);viewButton.hidden=false;actions.classList.add('has-result');
    };
    const spin=()=>{
      if(spinButton.disabled)return;const items=productsFor(categorySelect.value);if(!items.length){populateCategories();return;}
      cancelSpin();const selected=randomItem(items,lastProductId),index=items.indexOf(selected),start=angle,end=drumTarget(start,index,items.length),duration=randomDuration(),run=generation;
      result=null;viewButton.hidden=true;actions.classList.remove('has-result');spinButton.disabled=true;categorySelect.disabled=true;spinButton.textContent='Выбираем…';closeButton.focus();buildWheel(items);readout.setAttribute('aria-live','off');
      if(reduceMotion()){angle=end;renderDrum(angle);finish(selected,index);return;}
      let started=null,visibleIndex=-1;
      const tick=now=>{if(run!==generation)return;if(started===null)started=now;const frame=spinFrame(start,end,now-started,duration);angle=frame.angle;renderDrum(angle);const current=drumIndex(angle,items.length);if(current!==visibleIndex){visibleIndex=current;showItem(items[current],current);}if(frame.done){finish(selected,index)}else frameId=requestAnimationFrame(tick);};
      frameId=requestAnimationFrame(tick);
    };
    launch.addEventListener('click',open);closeButton.addEventListener('click',close);overlay.addEventListener('click',event=>{if(event.target===overlay)close()});categorySelect.addEventListener('change',resetResult);spinButton.addEventListener('click',spin);
    viewButton.addEventListener('click',()=>{if(!result)return;const selected=productsFor(categorySelect.value).find(item=>String(item.id)===String(result.id));if(!selected){resetResult();populateCategories();return;}close();options.onSelect?.(selected);});
    document.addEventListener('keydown',event=>{if(!overlay.classList.contains('is-open'))return;if(event.key==='Escape')close();if(event.key==='Tab'){const controls=[...dialog.querySelectorAll('button:not([disabled]),select:not([disabled])')].filter(node=>!node.hidden),first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}});
  }
  window.GuestRoulette={mount,motion:{angleIndex,targetAngle,spinFrame,randomDuration,drumIndex,drumTarget}};
})();
