'use strict';
// CLI: `npm run seed` — populate demo data (idempotent).
const { seed } = require('./bootstrap');
seed();
console.log('Seed complete.');
process.exit(0);
