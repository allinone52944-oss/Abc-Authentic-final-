const fs = require('fs');
const vm = require('vm');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../../frontend/bdris-apply.html'), 'utf8');
function source(name) { const i = html.indexOf('function '+name+'('); const start = html.slice(i-6,i)==='async '?i-6:i; return html.slice(start,html.indexOf('\n}\n',i)+3); }
test('immediate acceptance and attachments wait; final saved original record is ready', () => {
 const c={};vm.createContext(c);vm.runInContext(source('originalRecordPending'),c);
 expect(c.originalRecordPending({attachmentsPending:true})).toBe(true);
 expect(c.originalRecordPending({attachmentsPending:true,pdf:{base64:'copy'}})).toBe(true);
 expect(c.originalRecordPending({attachmentsPending:false,original:{appId:'123456789'}})).toBe(false);
});
function setup(body='%PDF-1.4\nfixture', receipt=true) {
 let clicks=0;const calls=[]; const button={textContent:'PDF',disabled:false};
 const c={S:{ackNo:'123456789',_pdfTok:receipt?{'pdf-123456789':{tok:'paid-fixture',at:Date.now()}}:{}},
 canonicalAck:s=>String(s).replace(/\D/g,''),pdfChargeKey:s=>'pdf-'+s,$:()=>button,Date,Blob,File,Uint8Array,String,
 charge:async(kind,key)=>{calls.push([kind,key]);return 'paid-fixture';},getToken:()=> 'fixture-session',
 fetch:async(url,opts)=>{calls.push(opts.headers);return {ok:true,blob:async()=>new Blob([body])};},
 document:{createElement:()=>({click:()=>clicks++,remove(){}}),body:{appendChild(){}}},
 URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}},note(){},setTimeout(){},navigator:{},matchMedia:()=>({matches:false})};
 vm.createContext(c);vm.runInContext(source('downloadOriginal'),c);return {c,calls,button,clicks:()=>clicks};
}
test('valid original downloads using existing authenticated paid receipt',async()=>{
 const x=setup();expect(await x.c.downloadOriginal('/original.pdf','123456789')).toBe(true);
 expect(x.calls[0]).toEqual({Authorization:'Bearer fixture-session','X-Charge-Token':'paid-fixture'});expect(x.clicks()).toBe(1);expect(x.button.disabled).toBe(false);
});
test('HTML error with HTTP 200 is not downloaded as a government PDF',async()=>{
 const x=setup('<html>login</html>');expect(await x.c.downloadOriginal('/original.pdf','123456789')).toBe(false);expect(x.clicks()).toBe(0);
});
test('missing paid receipt requests the same canonical PDF key before download',async()=>{
 const x=setup(undefined,false);await x.c.downloadOriginal('/original.pdf','123456789');expect(x.calls[0]).toEqual(['pdf','pdf-123456789']);expect(x.clicks()).toBe(1);
});
