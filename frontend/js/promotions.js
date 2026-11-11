(function(){
'use strict';
const errors={INVALID_CODE:'কোডটি সঠিক নয় অথবা বন্ধ আছে।',WRONG_SERVICE:'এই কোডটি অন্য সেবার জন্য।',EXPIRED_CODE:'অফারের সময় শেষ হয়েছে।',OFFER_NOT_STARTED:'অফারটি এখনো শুরু হয়নি।',USER_LIMIT:'এই কোডের আপনার ব্যবহারের সীমা শেষ।',OFFER_LIMIT:'অফারের মোট ব্যবহারের সীমা শেষ।',NOT_YOUR_CODE:'এই কোডটি আপনার জন্য নয়।',INVALID_VALUE:'শুধু টাকা অথবা ১–১০০% দিন।',INVALID_LIMIT:'ব্যবহারের সীমা সঠিকভাবে দিন।',INVALID_TIME:'ভবিষ্যতের সময় অথবা মিনিটের মেয়াদ দিন।',CODE_TAKEN:'এই কোডটি আগেই আছে।',USE_AT_CHECKOUT:'সেবা নেওয়ার সময় এই কোড ব্যবহার করুন।',CREDIT_ALREADY_AVAILABLE:'এই সেবার ক্রেডিট আগে থেকেই আছে; সেটি খরচ করে আবার চেষ্টা করুন।',NOT_EDITABLE:'ব্যবহৃত ব্যক্তিগত কুপন আবার চালু করা যাবে না।',NO_ACCESS:'এই সেবায় আপনার অনুমতি নেই।',ZERO_VALUE:'এই সেবায় ছাড় প্রযোজ্য নয়।',SERVICE_CLOSED:'সেবাটি এখন বন্ধ আছে।'};
const money=n=>'৳'+Number(n).toLocaleString('bn-BD',{maximumFractionDigits:2});
let offset=0;
function sync(value){const t=new Date(value).getTime();if(Number.isFinite(t))offset=t-Date.now();}
function clock(el,start,end){el.dataset.start=start||'';el.dataset.end=end||'';tickOne(el);}
function tickOne(el){const now=Date.now()+offset,starts=new Date(el.dataset.start).getTime(),end=new Date(el.dataset.end).getTime();const future=Number.isFinite(starts)&&starts>now;const target=future?starts:end;if(!Number.isFinite(target)){el.textContent='নির্দিষ্ট মেয়াদ নেই';return;}const seconds=Math.max(0,Math.ceil((target-now)/1000));const h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;el.textContent=seconds===0?'অফার শেষ':(future?'শুরু হতে ':'বাকি ')+(h?h+':':'')+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');el.dataset.expired=String(!future&&seconds===0);}
setInterval(()=>document.querySelectorAll('.promo-clock').forEach(tickOne),1000);
async function api(path,body){const r=await ABC.api(path,body?{method:'POST',body}:undefined);const d=await r.json();if(!r.ok)throw Error(errors[d.error]||'কাজটি হয়নি—আবার চেষ্টা করুন।');sync(d.server_now);return d;}
function uiButton(text,fn){const b=document.createElement('button');b.type='button';b.className='btn';b.textContent=text;b.addEventListener('click',fn);return b;}
function mount(host,{service,engine=false,onQuote}){
 host.classList.add('promo-scope','promo-checkout');host.innerHTML='<h3>🎟️ প্রোমো কোড</h3><div class="promo-available"></div><div class="promo-fields"><input aria-label="প্রোমো কোড" maxlength="40" placeholder="কোড লিখুন"><button type="button" class="btn promo-apply">প্রয়োগ করুন</button><button type="button" class="btn promo-remove" hidden>✕ সরান</button></div><div class="promo-status" role="status"></div><div class="promo-result"></div>';
 const input=host.querySelector('input'),apply=host.querySelector('.promo-apply'),remove=host.querySelector('.promo-remove'),status=host.querySelector('.promo-status'),result=host.querySelector('.promo-result');
 let seq=0,busy=false,claimKey=null;
 const clear=()=>{seq++;result.replaceChildren();remove.hidden=true;claimKey=null;if(onQuote)onQuote(null);};
 input.addEventListener('input',()=>{if(!busy){clear();status.textContent='';}});
 remove.addEventListener('click',()=>{clear();input.value='';status.textContent='';});
 apply.addEventListener('click',async()=>{
  if(busy)return;const id=++seq;busy=true;input.disabled=true;apply.disabled=true;apply.textContent='যাচাই হচ্ছে…';status.dataset.error='false';
  try{const q=await api('/promos/quote',{service_id:service.id,code:input.value});if(id!==seq)return;
   result.innerHTML='<div class="promo-summary"><span>সেবার মূল্য</span><span></span><span>প্রোমো ছাড়</span><strong></strong><b>প্রদেয়</b><strong></strong></div><div class="promo-clock"></div>';
   const cells=result.querySelector('.promo-summary').children;cells[1].textContent=money(q.original);cells[3].textContent='− '+money(q.discount);cells[5].textContent=money(q.payable);clock(result.querySelector('.promo-clock'),q.starts_at,q.expires_at);
   if(engine){if(!claimKey)claimKey=crypto.randomUUID();await api('/promos/claim',{service_id:service.id,code:q.code,idempotency_key:claimKey});status.textContent=money(q.discount)+' এই সেবার ক্রেডিটে যোগ হয়েছে; মেয়াদের মধ্যে সেবা নিন।';apply.disabled=true;remove.hidden=true;input.disabled=true;return;}
   status.textContent='কোড প্রয়োগ হয়েছে; নিশ্চিত করার সময় আবার যাচাই হবে।';remove.hidden=false;if(onQuote)onQuote(q);
  }catch(e){result.replaceChildren();if(onQuote)onQuote(null);status.dataset.error='true';status.textContent=e.message;}
  finally{busy=false;if(!engine||status.dataset.error==='true'){input.disabled=false;apply.disabled=false;}apply.textContent='প্রয়োগ করুন';}
 });
 api('/promos').then(d=>{const available=host.querySelector('.promo-available');d.offers.filter(c=>!c.service_id||c.service_id===service.id).slice(0,6).forEach(c=>{const b=uiButton(c.code+' • '+(Number(c.amount)>0?money(c.amount):c.percent+'%'),()=>{if(busy||input.disabled)return;clear();input.value=c.code;});const t=document.createElement('span');t.className='promo-clock';clock(t,c.starts_at,c.expires_at);b.appendChild(t);available.appendChild(b);});}).catch(()=>{});
}
async function offers(host){try{const d=await api('/promos');if(!d.offers.length)return;host.className='promo-scope promo-strip';host.innerHTML='<h2>🎟️ চলমান অফার</h2><div class="promo-grid"></div>';d.offers.forEach(c=>{const card=document.createElement('article');card.className='promo-offer';const val=document.createElement('div');val.className='promo-value';val.textContent=Number(c.amount)>0?money(c.amount):c.percent+'%';const title=document.createElement('h3');title.textContent=c.code;const t=document.createElement('div');t.className='promo-clock';clock(t,c.starts_at,c.expires_at);const note=document.createElement('p');note.className='promo-muted';note.textContent='আপনার বাকি ব্যবহার: '+(Number(c.per_user_limit)-Number(c.my_uses));const link=document.createElement('a');link.className='btn';link.textContent='সেবা নিন →';link.href=c.service_id?'/service-detail.html?id='+encodeURIComponent(c.service_id):'/services.html';card.append(val,title,t,note,link);host.querySelector('.promo-grid').appendChild(card);});}catch(e){host.textContent='অফার লোড হয়নি—পাতা রিফ্রেশ করে চেষ্টা করুন।';}}
window.ABCPromo={mount,offers,clock,sync,message:code=>errors[code]||'প্রোমো যাচাই হয়নি—আবার চেষ্টা করুন।'};
})();
