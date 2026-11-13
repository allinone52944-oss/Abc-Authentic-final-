// GET /api/bdris-original-dl/:key?u&e&s — serves a stored original
// Form-1 PDF as an attachment for a signed link minted by
// POST /api/bdris-apply/applications/:ack/original-link (which ran the
// owner / paid-receipt check). No JWT header needed: the signature binds
// user + file + expiry. Mounted WITHOUT requireAuth for that reason.
'use strict';

const express = require('express');
const { verifyOriginalLink } = require('../lib/originalLink');
const { storedOriginalAvailable, storedOriginalPath } = require('../lib/storedOriginal');

const router = express.Router();

router.get('/:key', (req, res) => {
  const key = String(req.params.key || '');
  const q = req.query || {};
  if (!verifyOriginalLink(key, q.u, q.e, q.s)) {
    return res.status(403).type('text/plain; charset=utf-8').send('লিংকের মেয়াদ শেষ — আবার "আসল PDF" বোতাম চাপুন');
  }
  if (!storedOriginalAvailable(key)) {
    return res.status(404).type('text/plain; charset=utf-8').send('আসল PDF সার্ভারে পাওয়া যায়নি');
  }
  res.set('Cache-Control', 'private, no-store');
  res.download(storedOriginalPath(key), 'bdris-original-' + key + '.pdf');
});

module.exports = router;
