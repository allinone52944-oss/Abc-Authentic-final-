jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const user = require('../../routes/user');
const admin = require('../../routes/admin');
const { approveRechargeTx } = require('../../routes/sms');
const TX = { id:'t1', user_id:'u1', type:'recharge', amount:500, method:'bkash_personal', sender_no:'01712345678', trxid:'REAL1234', status:'pending' };
const app = () => { const a=express(); a.use(express.json()); a.use('/api/admin',admin); a.use('/api',user); return a; };
const signed = (r,id='u1',role='user') => r.set('Authorization','Bearer '+auth.signAccess({id,role}));
beforeEach(()=>db.__reset());
test('one provider payment cannot credit a second user through SMS', async()=>{
 db.__routeQuery([
  ['SELECT * FROM transactions',{rows:[TX]}],
  ['SELECT id, trxid, matched_recharge_id FROM incoming_sms',{rows:[{id:'s1',trxid:'REAL1234',matched_recharge_id:null}]}],
  ["status = 'approved' AND type = 'recharge'",{rows:[{id:'paid',user_id:'u2'}]}],
  ['UPDATE incoming_sms SET matched_recharge_id',{rows:[{id:'s1'}]}],
 ]);
 await expect(approveRechargeTx(db.__client,'t1','s1')).rejects.toThrow('DUPLICATE_TRANSACTION');
 expect(db.__client.query.mock.calls.filter(c=>c[0].includes('wallet_apply'))).toHaveLength(0);
});
test('ordinary admin approval consumes its matching SMS atomically',async()=>{
 db.__routeQuery([
  ['SELECT * FROM transactions',{rows:[TX]}],
  ['SELECT id, trxid, matched_recharge_id FROM incoming_sms',{rows:[{id:'s1',trxid:'REAL1234',matched_recharge_id:null}]}],
  ['SELECT * FROM incoming_sms',{rows:[{id:'s1',trxid:'REAL1234',amount:500,matched_recharge_id:null}]}],
  ['UPDATE incoming_sms SET matched_recharge_id',{rows:[{id:'s1'}]}],
 ]);
 await signed(request(app()).put('/api/admin/transactions/t1/approve'),'a1','admin').expect(200);
 const linked=db.__client.query.mock.calls.find(c=>c[0].includes('UPDATE incoming_sms SET matched_recharge_id'));
 expect(linked).toBeDefined(); expect(linked[1]).toEqual(['t1','s1','manual']);
});
test('repeated Auto submission reuses the same pending request',async()=>{
 db.__routeQuery([
  ['SELECT * FROM transactions',{rows:[{...TX,trxid:null}]}],
  ['SELECT COUNT(*)',{rows:[{count:'1'}]}],
  ['INSERT INTO transactions',{rows:[{...TX,id:'t2',trxid:null}]}],
 ]);
 const r=await signed(request(app()).post('/api/wallet/recharge/auto')).send({method:TX.method,sender_no:TX.sender_no,amount:500}).expect(201);
 expect(r.body.request_id).toBe('t1');
 expect(db.__client.query.mock.calls.filter(c=>c[0].includes('INSERT INTO transactions'))).toHaveLength(0);
});
test('Auto to Manual converts the owned pending request rather than creating another',async()=>{
 db.__routeQuery([
  ['SELECT * FROM transactions',{rows:[{...TX,trxid:null}]}],
  ['SELECT COUNT(*)',{rows:[{count:'1'}]}],
  ['UPDATE transactions SET trxid',{rows:[TX]}],
  ['INSERT INTO transactions',{rows:[{...TX,id:'t2'}]}],
 ]);
 const r=await signed(request(app()).post('/api/wallet/recharge')).send({method:TX.method,sender_no:TX.sender_no,amount:500,trxid:TX.trxid,request_id:'t1'}).expect(201);
 expect(r.body.transaction.id).toBe('t1');
 expect(db.__client.query.mock.calls.filter(c=>c[0].includes('INSERT INTO transactions'))).toHaveLength(0);
});
// Recharge Bug 1 (2026-11-11): the old rule ("admin cannot credit a
// number-only Auto without linking payment evidence") made a TrxID-less
// Auto recharge un-approvable forever when the SMS never arrived. The
// deliberate manual approve now allows it: the admin confirms in the
// modal after verifying the payment in their own statement, and the
// credit uses the traceable 'tx-<id>' reference. Fraud guards (amount
// mismatch, duplicate, already-processed) still apply.
test('admin CAN credit a number-only Auto recharge manually (deliberate approve)',async()=>{
 db.__routeQuery([['SELECT * FROM transactions',{rows:[{...TX,trxid:null}]}]]);
 const r=await signed(request(app()).put('/api/admin/transactions/t1/approve'),'a1','admin').expect(200);
 expect(r.body.ok).toBe(true);
 const w=db.__client.query.mock.calls.find(c=>c[0].includes('wallet_apply'));
 expect(w[1]).toEqual(['u1',500,'recharge','tx-t1','t1']);
});
test('Auto to Manual conversion still works when three requests are pending',async()=>{
 db.__routeQuery([
  ['SELECT * FROM transactions',{rows:[{...TX,trxid:null}]}],
  ['SELECT COUNT(*)',{rows:[{count:'3'}]}],
  ['UPDATE transactions SET trxid',{rows:[TX]}],
 ]);
 const r=await signed(request(app()).post('/api/wallet/recharge')).send({method:TX.method,sender_no:TX.sender_no,amount:500,trxid:TX.trxid}).expect(201);
 expect(r.body.transaction.id).toBe('t1');
});
