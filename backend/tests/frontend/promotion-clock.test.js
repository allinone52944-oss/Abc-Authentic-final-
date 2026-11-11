const vm=require('vm'),fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'../../../frontend/js/promotions.js'),'utf8');
function setup(){const context=vm.createContext({Date,Number,Math,String,window:{},document:{querySelectorAll:()=>[]},setInterval:()=>0});vm.runInContext(src,context);return context.window.ABCPromo;}
test('countdown shows 05:00 for a five minute offer',()=>{const p=setup();const now=new Date();p.sync(now.toISOString());const el={dataset:{}};p.clock(el,null,new Date(now.getTime()+300000).toISOString());expect(el.textContent).toBe('বাকি 05:00');});
test('countdown shows 30:00 for a thirty minute offer',()=>{const p=setup();const now=new Date();p.sync(now.toISOString());const el={dataset:{}};p.clock(el,null,new Date(now.getTime()+1800000).toISOString());expect(el.textContent).toBe('বাকি 30:00');});
test('expired offer displays ended and marks expired',()=>{const p=setup(),el={dataset:{}};p.clock(el,null,'2020-01-01');expect(el.textContent).toBe('অফার শেষ');expect(el.dataset.expired).toBe('true');});
test('server time overrides device clock for expiration',()=>{const p=setup(),el={dataset:{}};p.sync('2026-01-01T10:00:00Z');p.clock(el,null,'2026-01-01T10:05:00Z');expect(el.textContent).toBe('বাকি 05:00');});
