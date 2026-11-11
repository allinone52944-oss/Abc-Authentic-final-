const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'../../../frontend/js/admin.js'),'utf8');
function method(name){const start=src.indexOf('  async '+name+'('),open=src.indexOf('{',start);let depth=0;for(let i=open;i<src.length;i++){if(src[i]==='{')depth++;if(src[i]==='}'&&!--depth)return src.slice(start,i+1).trim();}throw Error(name);}
function setup(name='modalDeliverWithFile'){
 const file={name:'result.pdf'},btn={disabled:false},window={_modalDeliFile:file,_deliFile:file};
 const fetch=jest.fn().mockResolvedValue({ok:true,json:async()=>({ok:true,filename:'saved.pdf'})});
 const ABC={api:jest.fn().mockResolvedValue({ok:true,json:async()=>({order:{id:'o1',status:'new'}})})};
 const alert=jest.fn(),close=jest.fn();
 const obj=new Function('window','document','FormData','fetch','getAuthToken','alert','admErrBn','TABS','closeModal','show','confirm','ABC','isEngineOrder','return ({'+method(name)+'});')(window,{getElementById:()=>btn},class{append(){}},fetch,()=> 'test',alert,x=>x,{_orders:[]},close,()=>{},()=>true,ABC,()=>false);
 obj.findOrder=()=>({id:'o1',status:'new'});obj.smartTransition=jest.fn().mockResolvedValue(true);
 return {obj,window,btn,fetch,ABC,alert,close,file};
}
test('file already acknowledged is not uploaded again when status retry succeeds',async()=>{const t=setup();t.obj.smartTransition.mockRejectedValueOnce(Error('offline'));await t.obj.modalDeliverWithFile('o1');await t.obj.modalDeliverWithFile('o1');expect(t.fetch).toHaveBeenCalledTimes(1);expect(t.obj.smartTransition).toHaveBeenLastCalledWith('o1','new','delivered');});
test('simultaneous delivery clicks send only one upload',async()=>{const t=setup();let release;const response=new Promise(r=>{release=r;});t.fetch.mockImplementation(()=>response);const first=t.obj.modalDeliverWithFile('o1');await new Promise(r=>setImmediate(r));const second=t.obj.modalDeliverWithFile('o1');release({ok:true,json:async()=>({ok:true,filename:'saved.pdf'})});await first;await second;expect(t.fetch).toHaveBeenCalledTimes(1);});
test('successful HTTP response with unreadable body never advances delivery',async()=>{const t=setup('deliUpload');t.fetch.mockResolvedValue({ok:true,json:async()=>{throw Error('invalid JSON');}});await t.obj.deliUpload('o1');expect(t.obj.smartTransition).not.toHaveBeenCalled();expect(t.close).not.toHaveBeenCalled();expect(t.btn.disabled).toBe(false);expect(t.window._deliFile).toBe(t.file);});
test('delivery cannot infer processing when authoritative order read fails',async()=>{const t=setup();t.ABC.api.mockRejectedValue(Error('offline'));await t.obj.modalDeliverWithFile('o1');expect(t.obj.smartTransition).not.toHaveBeenCalled();expect(t.fetch).not.toHaveBeenCalled();});
