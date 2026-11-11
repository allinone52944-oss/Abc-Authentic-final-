import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[3]/'frontend'
OUT=Path('/tmp/browser/engine-feedback')
AFTER=True
PAGES=['birth-final','death-final','bdris-apply','land','land-khatian','land-mouza-map','nid-server-copy','nid-replica','qr-photo-verify']
async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch(headless=True)
  page=await b.new_page(viewport={'width':1280,'height':1800})
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  async def route(r):
   path=r.request.url.split('abc-authentic.store')[-1].split('?')[0]
   if path.startswith('/api/'):
    await r.fulfill(status=200,json={'ok':True,'price':10,'balance':100,'allowed':True,'verified':True,'charged':10});return
   if path=='/js/app.js':
    await r.fulfill(content_type='application/javascript',body="window.ABC={requireAuth:()=>true,user:()=>({id:1}),getUser:()=>({id:1}),getToken:()=>'',api:async (url,opts)=>fetch('/api'+url,opts),esc:s=>String(s),money:n=>n,bn:n=>n,toast:()=>{},isAdmin:()=>false};");return
   f=ROOT/path.lstrip('/')
   if f.is_file() and (path.endswith('.html') or path.endswith('.css') or path.endswith('.js')):
    body=f.read_text()
    if path.endswith('.html') and path!='/qr-photo-verify.html':
     import re
     body=re.sub(r'<script\b[^>]*>.*?</script>','',body,flags=re.S|re.I)
     if AFTER: body=body.replace('</head>','<script src="/js/engine-feedback.js?v=20261111-4" defer></script></head>')
    await r.fulfill(body=body,content_type='text/html' if path.endswith('.html') else 'text/css' if path.endswith('.css') else 'application/javascript');return
   await r.continue_()
  await page.route('https://abc-authentic.store/**',route)
  results=[]
  for width in [1158,1280,1536,390,360]:
   await page.set_viewport_size({'width':width,'height':1800})
   for name in PAGES:
    await page.goto('https://abc-authentic.store/'+name+'.html',wait_until='networkidle')
    await page.add_style_tag(content='*{animation:none!important;transition:none!important;opacity:1!important}')
    geom=await page.evaluate('''()=>{const f=document.querySelector('.form-card, main.card'),m=document.querySelector('.main,.app-shell,.wrap'); return {form:f?.getBoundingClientRect().width,workspace:m?.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth}}''')
    assert not geom['overflow'], (name,width,geom)
    results.append({'page':name,'width':width,**geom})
    if AFTER and width==1536:
     box=page.locator('.err').first
     if await box.count():
      await page.evaluate("()=>{window.scrollTo(0,document.body.scrollHeight);const e=document.querySelector('.err'); e.textContent='নমুনা ত্রুটি';e.classList.add('on')}")
      await page.wait_for_timeout(100)
      assert await box.evaluate('(e)=>document.activeElement===e'), name
  await page.set_viewport_size({'width':390,'height':700})
  await page.goto('https://abc-authentic.store/qr-photo-verify.html',wait_until='networkidle')
  from PIL import Image
  Image.new('RGB',(100,100),(100,130,90)).save(OUT/'sample.png')
  await page.locator('#qrFile').set_input_files(OUT/'sample.png');await page.locator('#photoFile').set_input_files(OUT/'sample.png')
  await page.locator('#goBtn').click();await page.wait_for_timeout(300)
  geom=await page.locator('#okBox').evaluate('(e)=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,visible:getComputedStyle(e).display,focused:document.activeElement===e})')
  await page.screenshot(path=str(OUT/(('after' if AFTER else 'before')+'-qr.png')))
  print('QR simulated response geometry:',geom)
  if AFTER:
   assert geom['top']>=0 and geom['bottom']<700 and geom['focused'], geom
   await page.locator('.engine-new-check').click()
   assert await page.locator('#qrFile').evaluate('(e)=>e.files.length')==0
   await page.evaluate("()=>{const b=document.getElementById('goBtn');b.disabled=true;b.innerHTML='<span class=spin></span>যাচাই চলছে'}")
   await page.wait_for_timeout(100)
   assert await page.locator('.engine-pending').is_visible()
   await page.evaluate("()=>{const b=document.getElementById('goBtn');b.disabled=false;b.textContent='যাচাই করুন';showErrResult('নমুনা ব্যর্থতা','uncertain')}")
   await page.wait_for_timeout(100)
   assert await page.locator('#errBox').evaluate('(e)=>document.activeElement===e')
   assert not await page.locator('.engine-pending').is_visible()
   await page.screenshot(path=str(OUT/'after-qr-failure.png'))
  print('Original form still populated:',await page.locator('#qrFile').evaluate('(e)=>e.files.length'))
  print('Errors:',errors)
  print(json.dumps(results))
  (OUT/('after.json' if AFTER else 'before.json')).write_text(json.dumps({'layouts':results,'qr':geom,'errors':errors},indent=2))
  await b.close()
asyncio.run(main())
