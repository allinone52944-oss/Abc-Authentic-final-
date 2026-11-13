// ONE-TAP (2026-11-13): the original-PDF button asks the owner-only
// server route for a short-lived signed link and opens it as a plain
// link (a real file download on every device). A stored copy is reused;
// "missing" tells the home button to fetch it once from the office site.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../../frontend/bdris-apply.html'), 'utf8');
function source(name) { const i = html.indexOf('function '+name+'('); const start = html.slice(i-6,i)==='async '?i-6:i; return html.slice(start,html.indexOf('\n}\n',i)+3); }
test('immediate acceptance and attachments wait; final saved original record is ready', () => {
 const c={};vm.createContext(c);vm.runInContext(source('originalRecordPending'),c);
 expect(c.originalRecordPending({attachmentsPending:true})).toBe(true);
 expect(c.originalRecordPending({attachmentsPending:false,original:{appId:'123456789'}})).toBe(false);
});
function setup(reply={ok:true,status:200,body:{ok:true,url:'/api/bdris-original-dl/123456789?u=1&e=1&s=x'}}, receipt=true) {
 const calls=[]; const links=[]; const button={textContent:'PDF',disabled:false};
 const c={S:{ackNo:'123456789',_pdfTok:receipt?{'pdf-123456789':{tok:'paid-fixture',at:Date.now()}}:{}},
 canonicalAck:s=>String(s).replace(/\D/g,''),pdfChargeKey:s=>'pdf-'+s,$:()=>button,Date,String,encodeURIComponent,
 charge:async(kind,key)=>{calls.push(['charge',kind,key]);return 'paid-fixture';},getToken:()=> 'fixture-session',
 fetch:async(url,opts)=>{calls.push([url,opts.method,opts.headers]);return {ok:reply.ok,status:reply.status,json:async()=>reply.body};},
 document:{createElement:()=>{const a={click(){links.push(a.href);},remove(){}};return a;},body:{appendChild(){}}},
 note(){}};
 vm.createContext(c);vm.runInContext(source('downloadOriginal'),c);return {c,calls,links,button};
}
test('paid receipt gets a signed link from the owner-only route and opens it once',async()=>{
 const x=setup();expect(await x.c.downloadOriginal('/x.pdf','123456789')).toBe(true);
 expect(x.calls[0]).toEqual(['/api/bdris-apply/applications/123456789/original-link','POST',{Authorization:'Bearer fixture-session','X-Charge-Token':'paid-fixture'}]);
 expect(x.links).toEqual(['/api/bdris-original-dl/123456789?u=1&e=1&s=x']);expect(x.button.disabled).toBe(false);
});
test('missing paid receipt charges the same canonical PDF key first',async()=>{
 const x=setup(undefined,false);await x.c.downloadOriginal('/x.pdf','123456789');
 expect(x.calls[0]).toEqual(['charge','pdf','pdf-123456789']);expect(x.links.length).toBe(1);
});
test('home button learns the server has no stored copy yet',async()=>{
 const x=setup({ok:false,status:404,body:{error:'FILE_MISSING'}});
 expect(await x.c.downloadOriginal('stored','123456789')).toBe('missing');expect(x.links.length).toBe(0);
});
test('a refused link never opens anything',async()=>{
 const x=setup({ok:false,status:403,body:{error:'X'}});
 expect(await x.c.downloadOriginal('/x.pdf','123456789')).toBe(false);expect(x.links.length).toBe(0);
});
