const {refundOrderPrice}=require('../../lib/serviceCredits');
test('refunded 40 remains usable after another offer expires, scoped to the same service',async()=>{
 const expiring={id:'other-offer',amount:50,remaining:10,expires_at:1000};let permanent=0;
 const client={query:jest.fn(async(sql,p)=>{
  if(/FROM transactions/.test(sql))return {rows:[{trxid:'order-review-u1:svc',amount:-40}]};
  if(/FROM service_credits/.test(sql))return {rows:sql.includes('OR expires_at')?[expiring]:[]};
  if(/UPDATE service_credits/.test(sql)){expiring.remaining+=p[0];return {rows:[]};}
  if(/INSERT INTO service_credits/.test(sql)){expect(p.slice(0,2)).toEqual(['u1','s1']);expect(sql).toMatch(/\$4, NULL/);permanent+=p[3];return {rows:[]};}
  return {rows:[]};
 })};
 await refundOrderPrice(client,{id:'o1',user_id:'u1',service_id:'s1',price:40,idempotency_key:'review'},'refund');
 const now=2000;const usable=permanent+(expiring.expires_at>now?expiring.remaining:0);
 expect(usable).toBe(40);expect(expiring.remaining).toBe(10);
 const wallet=client.query.mock.calls.find(([sql])=>sql.includes('wallet_apply'));
 expect(wallet[1]).toEqual(['u1',0,'refund','refund-o1']);
});
