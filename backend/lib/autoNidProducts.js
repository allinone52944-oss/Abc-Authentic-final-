'use strict';

const products = Object.freeze({
  backup: { engineId: 'nid-auto-server-copy', label: 'Server Copy (SV Backup)' },
  premium: { engineId: 'nid-auto-server-copy-premium', label: 'SV Copy Premium' },
  half: { engineId: 'nid-auto-server-copy-half', label: 'Half Server Copy' },
});
const engineIds = Object.values(products).map(product => product.engineId);

module.exports = { products, engineIds };
