const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = name => fs.readFileSync(path.join(__dirname, '../../../frontend', name + '.html'), 'utf8');
const extract = (name, from, to) => { const s=read(name); return s.slice(s.indexOf(from),s.indexOf(to,s.indexOf(from))); };
function el(){return {innerHTML:'loading',textContent:'',value:'',style:{},disabled:false,insertAdjacentHTML(_,html){this.innerHTML+=html;}};}
function env(api){const nodes={};return {nodes,context:{ABC:{api,httpErrBn:()=> 'failed',showPageMsg:jest.fn()},document:{getElementById:id=>nodes[id]||(nodes[id]=el()),querySelector:()=>el(),querySelectorAll:()=>[]},window:{},URLSearchParams,location:{search:''},esc:String,escapeHtml:String,STBN:{},console}};}
test.each(['http','network'])('failed orders page 2 retries page 2, not page 3: %s',async mode=>{
 let fail=true;const requested=[];
 const {context,nodes}=env(async url=>{requested.push(url);if(fail){if(mode==='network')throw Error('offline');return {ok:false};}return {ok:true,json:async()=>({orders:[{id:'two',service_name:'second page',status:'pending',created_at:'2026-11-10'}],total:30})};});
 vm.runInNewContext('let page=2,status="",_ordersLoading=false,_ordersPageLoaded=false;'+extract('orders','async function load(){','\ninit();'),context);
 await context.load();fail=false;await context.load();
 expect(requested).toEqual(['/orders?limit=10&page=2','/orders?limit=10&page=2']);
 expect(nodes.list.innerHTML).toContain('second page');
});
test.each(['order-detail','order-status'])('%s preserves unsent chat on HTTP and network errors and clears after success',async name=>{
 let mode='http';const {context,nodes}=env(async()=>{if(mode==='network')throw Error('offline');return {ok:mode==='ok',status:503};});
 const s=read(name);const end=name==='order-detail'?'\ninit();':'// Audit #48 — customer cancel';
 vm.runInNewContext('const oid="test";let _chatSending=false;'+s.slice(s.indexOf('async function sendChat'),s.indexOf(end,s.indexOf('async function sendChat'))),context);
 context.loadChat=jest.fn(async()=>{});nodes.chatIn=el();nodes.chatIn.value='আমার ফাইলটি যাচাই করুন';
 await context.sendChat();expect(nodes.chatIn.value).toBe('আমার ফাইলটি যাচাই করুন');
 mode='network';await context.sendChat();expect(nodes.chatIn.value).toBe('আমার ফাইলটি যাচাই করুন');
 mode='ok';await context.sendChat();expect(nodes.chatIn.value).toBe('');expect(context.loadChat).toHaveBeenCalledTimes(1);
});
test.each(['order-detail','order-status'])('%s failed timeline leaves loading state and can retry',async name=>{
 let fail=true;const {context,nodes}=env(async()=>({ok:!fail,json:async()=>({history:[{to_status:'processing'}]})}));
 const source=read(name);const start=source.indexOf('async function loadTimelineHistory');const end=source.indexOf('\n}',start)+2;
 vm.runInNewContext('const oid="test";'+source.slice(start,end),context);
 context.renderTimeline=jest.fn();context.window._currentOrder={status:'processing'};
 await context.loadTimelineHistory({status:'processing'});expect(nodes.timeline.innerHTML).not.toBe('loading');
 fail=false;await context.loadTimelineHistory({status:'processing'});expect(context.renderTimeline).toHaveBeenCalledTimes(1);
});
test('history retry reads back records and retains original index downloads',async()=>{
 let fail=true;const {context}=env(async()=>({ok:!fail,json:async()=>({items:[{title:'engine file',kind:'engine',documents:[{url:'/engine/file'}]}]})}));
 context.render=jest.fn();vm.runInNewContext('let _items=[];'+extract('history','async function loadHistory()','\nasync function init()'),context);
 await context.loadHistory();fail=false;await context.loadHistory();
 expect(context.render).toHaveBeenCalledTimes(1);expect(vm.runInNewContext('_items[0].documents[0].url',context)).toBe('/engine/file');
});
