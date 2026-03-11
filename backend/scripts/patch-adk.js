/**
 * scripts/patch-adk.js
 *
 * Fixes a known bug in @google/adk's CJS build where it imports 'lodash-es'
 * (an ESM-only package) instead of 'lodash'. This breaks any CommonJS backend.
 *
 * Run automatically via "postinstall" in package.json.
 * Safe to re-run — idempotent.
 *
 * Upstream issue: https://github.com/google/adk-js/issues
 */

const fs = require('fs');
const path = require('path');

const CJS_ENTRY = path.join(__dirname, '../node_modules/@google/adk/dist/cjs/index.js');

if (!fs.existsSync(CJS_ENTRY)) {
  console.log('patch-adk: @google/adk CJS build not found, skipping patch.');
  process.exit(0);
}

let src = fs.readFileSync(CJS_ENTRY, 'utf8');

// Already patched?
if (!src.includes('lodash-es')) {
  console.log('patch-adk: already patched, nothing to do.');
  process.exit(0);
}

// Replace all references: require('lodash-es') → require('lodash')
//                          from 'lodash-es'     → from 'lodash'
const patched = src
  .replace(/require\(['"]lodash-es['"]\)/g, "require('lodash')")
  .replace(/from ['"]lodash-es['"]/g, "from 'lodash'");

fs.writeFileSync(CJS_ENTRY, patched, 'utf8');
console.log('patch-adk: ✅ replaced lodash-es → lodash in @google/adk CJS build');
