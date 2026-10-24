'use strict';
/**
 * pdf-id pickIds — the official card PDF is the last-resort
 * source of the holder's numbers when the portal's identity
 * section renders nothing scrapable (2026-10-24 live case:
 * National ID stayed '--' through two fixes).
 */
const path = require('path');
const { pickIds } = require(path.join(__dirname, '..', '..', '..', 'engines', 'nid-server-copy', 'pdf-id'));

describe('nid-server-copy pdf-id pickIds', () => {
  test('10-digit new NID and 17-digit PIN both recovered', () => {
    const ids = pickIds('National ID: 1234567890\nPIN: 19891234567890123\nName: Someone');
    expect(ids.nid).toBe('1234567890');
    expect(ids.pin).toBe('19891234567890123');
  });

  test('13-digit old NID used when no 10-digit candidate exists', () => {
    const ids = pickIds('ID 1985123456789 PIN 19891234567890123');
    expect(ids.nid).toBe('1985123456789');
    expect(ids.pin).toBe('19891234567890123');
  });

  test('Bengali digits and space-split runs are handled', () => {
    const ids = pickIds('জাতীয় পরিচয়: ১২৩৪৫৬৭৮৯০\nপিন: 1989 1234 5678 9012 3');
    expect(ids.nid).toBe('1234567890');
    expect(ids.pin).toBe('19891234567890123');
  });

  test('mobile numbers and short numbers are not mistaken for IDs', () => {
    const ids = pickIds('Mobile: 01712345678 DOB: 1989-02-12 Area: 12345');
    expect(ids.nid).toBeNull();
    expect(ids.pin).toBeNull();
  });
});
