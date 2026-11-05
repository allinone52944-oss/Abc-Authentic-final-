// Audit #68 — one cache rule for every static file, used by both
// express.static mounts in server.js (frontend + /assets).
//
// Versioned (?v=) -> 1-year immutable: the URL changes when the file
// changes, so a long cache can never serve stale bytes.
// Unversioned -> 1 hour + must-revalidate: a changed file is picked
// up within the hour, never stuck for a year. (Before this, EVERY
// .js/.css got 1-year immutable whether versioned or not, so an
// unversioned file like socket.io.min.js could stay stale for a
// year; /assets got no Cache-Control at all.)
//
// HTML is always no-cache (the ?v= references live there).
// Unknown extensions return undefined: Express defaults apply.
// Fail-safe direction: no URL proof of versioning -> short cache,
// never immutable.
function cacheControlFor(url, filePath) {
  if (/\.html$/i.test(filePath)) return 'no-cache, no-store, must-revalidate';
  if (/\.(css|js|json|png|jpe?g|svg|ico|woff2?|ttf)$/i.test(filePath)) {
    const versioned = /[?&]v=[^&]+/.test(url || '');
    return versioned
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600, must-revalidate';
  }
  return undefined;
}

module.exports = { cacheControlFor };
