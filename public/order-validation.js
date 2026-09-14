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
})(globalThis);
