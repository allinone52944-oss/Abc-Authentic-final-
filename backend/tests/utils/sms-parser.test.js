// Unit tests for backend/utils/sms-parser.js (pure functions).
const { parseSms, detectMethod, detectDirection, parseAmount } = require('../../utils/sms-parser');

describe('parseSms — bKash money-in (happy path)', () => {
  const msg = 'You have received Tk 500.00 from 01712345678. TrxID 9HXK2LQM4N. New balance Tk 1200.00.';
  test('extracts method, amount, sender, trxid, direction', () => {
    const p = parseSms(msg, 'bKash');
    expect(p).toMatchObject({
      method: 'bkash',
      amount: 500,
      sender: '01712345678',
      trxid: '9HXK2LQM4N',
      direction: 'in',
    });
  });
});

describe('parseSms — method detection', () => {
  test('Nagad by sender number 16167', () => {
    const p = parseSms('You have received Tk 1000 from 01899998888. TrxID ABCD1234EF.', '16167');
    expect(p.method).toBe('nagad');
  });
  test('Rocket by sender number 16216', () => {
    const p = parseSms('Cash In Tk 250. A/C:01711112222 TrxID XYZ99999.', '16216');
    expect(p.method).toBe('rocket');
    expect(p.sender).toBe('01711112222');
  });
  test('method from message body when sender unknown', () => {
    expect(parseSms('Nagad: Tk 100 received. TrxID A1B2C3D4.', 'UNKNOWN').method).toBe('nagad');
    expect(parseSms('Rocket cash in Tk 100. TrxID A1B2C3D4.', '').method).toBe('rocket');
  });
  test('unknown method when nothing matches', () => {
    expect(parseSms('Tk 100 received. TrxID A1B2C3D4.', '99999').method).toBe('unknown');
  });
  test('detectMethod unit: aliases', () => {
    expect(detectMethod('', '16247')).toBe('bkash');
    expect(detectMethod('', 'DBBL')).toBe('rocket');
  });
});

describe('parseSms — amount formats', () => {
  test('TK with commas', () => {
    expect(parseSms('Received TK 1,250.50. TrxID ABCDEF1234.', 'bKash').amount).toBe(1250.5);
  });
  test('BDT prefix', () => {
    expect(parseSms('BDT 2000 received. TrxID ABCDEF1234.', 'bKash').amount).toBe(2000);
  });
  test('TrxID-only message (no amount) still parses', () => {
    const p = parseSms('TrxID: ABCDEF123456 confirmed.', 'bKash');
    expect(p.trxid).toBe('ABCDEF123456');
    expect(p.amount).toBeNull();
  });
  test('TxnID / Ref variants', () => {
    expect(parseSms('TxnID: XYZ123ABC credited Tk 10.', 'bKash').trxid).toBe('XYZ123ABC');
    expect(parseSms('Ref: QWE789RTY Tk 10 received.', 'bKash').trxid).toBe('QWE789RTY');
  });
  test('parseAmount rejects zero / non-numeric', () => {
    expect(parseAmount('Tk 0 received')).toBeNull();
    expect(parseAmount('no money here')).toBeNull();
  });
});

describe('parseSms — direction', () => {
  test('cash-out is "out"', () => {
    const p = parseSms('Cash Out Tk 200.00 sent to 01900000000. TrxID OUT123ABC.', 'bKash');
    expect(p.direction).toBe('out');
  });
  test('debited is "out"', () => {
    expect(detectDirection('Your account debited Tk 50')).toBe('out');
  });
  test('no signal is "unknown"', () => {
    expect(detectDirection('TrxID ABC123XYZ')).toBe('unknown');
  });
});

describe('parseSms — failure / edge cases', () => {
  test('null for empty / blank / garbage input', () => {
    expect(parseSms('', 'bKash')).toBeNull();
    expect(parseSms('   ', 'bKash')).toBeNull();
    expect(parseSms(null, 'bKash')).toBeNull();
    expect(parseSms('hello world, nice weather', 'bKash')).toBeNull();
  });

  test('SQL-injection-shaped text does not break parsing', () => {
    const p = parseSms("Tk 500'; DROP TABLE users; -- TrxID ABC123XYZ", 'bKash');
    expect(p).not.toBeNull();
    expect(p.amount).toBe(500);
  });

  test('very long input does not hang', () => {
    const p = parseSms('Tk 10 TrxID ABC123XYZ ' + 'x'.repeat(5000), 'bKash');
    expect(p.amount).toBe(10);
  });

  test('trxid is uppercased', () => {
    expect(parseSms('trxid: abc123xyz9 received Tk 5.', 'bKash').trxid).toBe('ABC123XYZ9');
  });

  test('sender absent → null (not crash)', () => {
    const p = parseSms('Tk 100 received. TrxID ABC123XYZ.', 'bKash');
    expect(p.sender).toBeNull();
  });
});
