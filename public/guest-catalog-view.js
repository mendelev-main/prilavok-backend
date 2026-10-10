(function(root){
 'use strict';
 // Stock and transport revision do not change the catalogue's visual structure.
 function signature(menu){return JSON.stringify({categories:menu?.categories||[],products:(menu?.products||[]).map(({availability_known,available_quantity,...product})=>product)});}
 function stock(card,available,imageSelector){
  card.classList.toggle('sold-out',!available);
  const image=card.querySelector(imageSelector);if(!image)return;
  const layer=image.querySelector('.sold-out-layer');
  if(available){layer?.remove()}else if(!layer){const overlay=document.createElement('div');overlay.className='sold-out-layer';overlay.setAttribute('aria-hidden','true');image.appendChild(overlay)}
 }
 root.GuestCatalogView={signature,stock};
})(typeof window!=='undefined'?window:globalThis);
