 'use strict';
function fail(code, statusCode = 400) { const e = new Error(code); e.statusCode = statusCode; throw e; }
function validateCampaign(b, now = Date.now()) {
  const amount = Number(b.amount || 0), percent = Number(b.percent || 0);
  const per = Number(b.per_user_limit ?? 1), total = b.max_uses !== null && b.max_uses !== undefined && b.max_uses !== '' ? Number(b.max_uses) : null;
  const minutes = b.duration_minutes !== null && b.duration_minutes !== undefined && b.duration_minutes !== '' ? Number(b.duration_minutes) : null;
  const starts = b.starts_at ? new Date(b.starts_at).getTime() : now;
  const ends = minutes ? starts + minutes * 60000 : (b.expires_at ? new Date(b.expires_at).getTime() : null);
  if (!/^[A-Z0-9_-]{2,40}$/.test(String(b.code || '').trim().toUpperCase()) || !['promo','cashback'].includes(b.type)) fail('INVALID_INPUT');
  if (!Number.isFinite(amount) || !Number.isFinite(percent) || amount < 0 || percent < 0 || percent > 100 || (amount > 0) === (percent > 0)) fail('INVALID_VALUE');
  if (!Number.isInteger(per) || per < 1 || per > 10000 || (total !== null && (!Number.isInteger(total) || total < 1))) fail('INVALID_LIMIT');
  if (!Number.isFinite(starts) || (ends !== null && (!Number.isFinite(ends) || ends <= now || ends <= starts)) || (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600))) fail('INVALID_TIME');
  return { amount, percent, per, total, starts: new Date(starts).toISOString(), ends: ends === null ? null : new Date(ends).toISOString() };
}
function assertEligible(c, {userId, serviceId, used = 0, now = Date.now()}) {
  if (!c || !c.is_campaign || c.status !== 'active') fail('INVALID_CODE',404);
  if (c.user_id && c.user_id !== userId) fail('NOT_YOUR_CODE',403);
  if (c.service_id && c.service_id !== serviceId) fail('WRONG_SERVICE');
  if (c.starts_at && new Date(c.starts_at).getTime() > now) fail('OFFER_NOT_STARTED');
  if (c.expires_at && new Date(c.expires_at).getTime() <= now) fail('EXPIRED_CODE');
  if (c.max_uses != null && Number(c.used_count) >= Number(c.max_uses)) fail('OFFER_LIMIT');
  if (Number(used) >= Number(c.per_user_limit)) fail('USER_LIMIT');
}
function discount(c, price) {
  if (!Number.isFinite(price) || price < 0) fail('PRICE_UNAVAILABLE',503);
  const value = Number(c.amount) > 0 ? Number(c.amount) : price * Number(c.percent) / 100;
  if (!Number.isFinite(value) || value <= 0) fail('ZERO_VALUE');
  const saved = Math.round(Math.min(price,value) * 100) / 100;
  if (saved <= 0) fail('ZERO_VALUE');
  return saved;
}
async function quote(client, code, userId, serviceId, price, lock = false) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,40}$/.test(normalized)) fail('INVALID_CODE');
  const r = await client.query('SELECT * FROM coupons WHERE code = $1' + (lock ? ' FOR UPDATE' : ''), [normalized]);
  const c = r.rows[0];
  if (!c) fail('INVALID_CODE',404);
  const u = await client.query('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2', [c.id,userId]);
  assertEligible(c,{userId,serviceId,used:Number(u.rows[0]?.n || 0)});
  const saved = discount(c,price);
  return { coupon:c, code:c.code, original:price, discount:saved, payable:Math.round((price-saved)*100)/100, expires_at:c.expires_at, starts_at:c.starts_at, server_now:new Date().toISOString(), remaining_uses:Number(c.per_user_limit)-Number(u.rows[0]?.n || 0) };
}
async function record(client, q, userId, serviceId, ref) {
  await client.query('INSERT INTO coupon_redemptions (coupon_id,user_id,service_id,ref,amount) VALUES ($1,$2,$3,$4,$5)',[q.coupon.id,userId,serviceId,ref,q.discount]);
  await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1',[q.coupon.id]);
}
function publicQuote(q) { const {coupon,...data} = q; return data; }
module.exports = {validateCampaign,assertEligible,discount,quote,record,publicQuote,fail};
