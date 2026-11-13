const { mintOriginalLink, verifyOriginalLink, LINK_TTL_MS } = require('../../lib/originalLink');

function parts(url) {
  const u = new URL('http://x' + url);
  return { key: u.pathname.split('/').pop(), u: u.searchParams.get('u'), e: u.searchParams.get('e'), s: u.searchParams.get('s') };
}

describe('signed original-PDF link', () => {
  test('a minted link verifies for the same user and file', () => {
    const p = parts(mintOriginalLink('266392130', 7));
    expect(verifyOriginalLink(p.key, p.u, p.e, p.s)).toBe(true);
  });
  test('another user id is rejected', () => {
    const p = parts(mintOriginalLink('266392130', 7));
    expect(verifyOriginalLink(p.key, '8', p.e, p.s)).toBe(false);
  });
  test('another file is rejected', () => {
    const p = parts(mintOriginalLink('266392130', 7));
    expect(verifyOriginalLink('265775264', p.u, p.e, p.s)).toBe(false);
  });
  test('an expired link is rejected', () => {
    const p = parts(mintOriginalLink('266392130', 7, Date.now() - LINK_TTL_MS - 1000));
    expect(verifyOriginalLink(p.key, p.u, p.e, p.s)).toBe(false);
  });
  test('link lifetime is five minutes', () => {
    expect(LINK_TTL_MS).toBe(5 * 60 * 1000);
  });
});
