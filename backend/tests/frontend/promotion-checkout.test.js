const vm=require('vm'),fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'../../../frontend/js/promotions.js'),'utf8');
function setup(engine=false){
 const nodes=new Map(),clocks=[];let tick,now=Date.parse('2026-11-11T10:00:00Z');
 function node(){return {dataset:{},disabled:false,hidden:false,value:'SAVE',textContent:'',children:[],classList:{add(){}},events:{},addEventListener(k,f){this.events[k]=f;},replaceChildren(){this.children=[];this.innerHTML='';},querySelector(k){return nodes.get(k);},appendChild(n){this.children.push(n);}};}
 ['input','.promo-apply','.promo-remove','.promo-status','.promo-result','.promo-available'].forEach(k=>nodes.set(k,node()));
 const result=nodes.get('.promo-result'),clock=node(),summary=node();summary.children=Array.from({length:6},node);nodes.set('.promo-summary',summary);nodes.set('.promo-clock',clock);clocks.push(clock);
 const api=jest.fn(async(url)=>({ok:true,json:async()=>url==='/promos'?{offers:[]}:url==='/promos/claim'?{credited:20}: {code:'SAVE',original:200,discount:20,payable:180,expires_at:'2026-11-11T10:05:00Z',server_now:'2026-11-11T10:00:00Z'}}));
 class FakeDate extends Date {constructor(...a){super(...(a.length?a:[now]));} static now(){return now;}}
 const onQuote=jest.fn();const ctx=vm.createContext({Date:FakeDate,Number,Math,String,window:{},crypto:{randomUUID:()=> 'retry-key'},document:{querySelectorAll:()=>clocks,createElement:node},setInterval:f=>{tick=f;},ABC:{api}});vm.runInContext(src,ctx);
 const host=node();ctx.window.ABCPromo.mount(host,{service:{id:'s1'},engine,onQuote});
 return {api,onQuote,nodes,apply:()=>nodes.get('.promo-apply').events.click(),expire:()=>{now+=300001;tick();},clock,result};
}
test('five minute checkout expiration clears the applied discount without submitting an order',async()=>{const t=setup();await t.apply();expect(t.onQuote.mock.calls.at(-1)[0].payable).toBe(180);t.expire();expect(t.onQuote.mock.calls.at(-1)[0]).toBeNull();expect(t.clock.dataset.expired).toBe('true');expect(t.api.mock.calls.some(([url])=>url==='/orders')).toBe(false);});
test('lost engine claim response retries the same claim without re-quoting an exhausted code',async()=>{const t=setup(true);let claims=0;t.api.mockImplementation(async url=>{if(url==='/promos')return {ok:true,json:async()=>({offers:[]})};if(url==='/promos/claim'){if(++claims===1)throw Error('network');return {ok:true,json:async()=>({credited:20,already:true})};}return {ok:true,json:async()=>({code:'SAVE',original:200,discount:20,payable:180,expires_at:'2026-11-11T10:05:00Z'})};});await t.apply();await t.apply();expect(t.api.mock.calls.filter(([url])=>url==='/promos/quote')).toHaveLength(1);const bodies=t.api.mock.calls.filter(([url])=>url==='/promos/claim').map(([,options])=>options.body);expect(bodies).toHaveLength(2);expect(bodies[0].idempotency_key).toBe(bodies[1].idempotency_key);expect(t.nodes.get('.promo-status').dataset.error).toBe('false');});
