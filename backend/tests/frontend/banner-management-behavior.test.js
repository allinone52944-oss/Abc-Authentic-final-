const fs = require('fs');
const path = require('path');
const vm = require('vm');
function harness() {
 const src = fs.readFileSync(path.resolve(__dirname, '../../../frontend/js/admin.js'), 'utf8');
 const block = src.slice(src.indexOf('/* ---------------- BANNERS'), src.indexOf('/* ---------------- NOTICES'));
 const nodes = {}; const refresh = jest.fn(); const alerts = jest.fn();
 const ctx = vm.createContext({window:{}, TABS:{}, content:{innerHTML:''}, esc:String, bn:String,
 document:{getElementById:id=>nodes[id]||null,querySelectorAll:()=>[]},
 fetch:jest.fn(async()=>({ok:false,json:async()=>({error:'FAILED'})})),
 ABC:{api:jest.fn(async()=>({ok:false,json:async()=>({error:'FAILED'})}))},
 alert:alerts,confirm:()=>true,show:refresh,console});
 vm.runInContext(block,ctx); return {ctx,manager:ctx.window.AdmBn,refresh,alerts,nodes};
}
test('failed activation does not refresh as if saved',async()=>{const h=harness();await h.manager.toggle('abc',false);expect(h.alerts).toHaveBeenCalled();expect(h.refresh).not.toHaveBeenCalled();});
test('failed deletion retains current list and reports failure',async()=>{const h=harness();await h.manager.del('abc');expect(h.alerts).toHaveBeenCalled();expect(h.refresh).not.toHaveBeenCalled();});
test('catalog failure never caches an error as a catalog',async()=>{const h=harness();await expect(h.manager._cat()).rejects.toThrow();expect(h.manager._catalog).toBeNull();});
test('failed list response is not presented as empty inventory',async()=>{const h=harness();await h.ctx.TABS.banners();expect(h.ctx.content.innerHTML).not.toContain('এখনো কোনো ব্যানার তৈরি করা হয়নি');});
