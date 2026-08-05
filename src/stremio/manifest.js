'use strict';

const pkg = require('../../package.json');

/**
 * Build the Stremio manifest. No user data embedded — config is per-URL.
 * @param {boolean} isConfigured - true when this manifest was requested
 *   with a URL that already decodes to a valid per-user config token, so
 *   Stremio should offer "Install" directly instead of "Configure" (which
 *   sends the user to the bare config page and drops the token already in
 *   the URL). False for the generic/no-token manifest request.
 * @param {string} [baseUrl] - origin (protocol+host) of the running
 *   server, used to build an absolute logo URL. Omitted in contexts
 *   (like tests) that don't have a real request.
 */
function buildManifest(isConfigured = false, baseUrl = '') {
  return {
    id: 'community.febboxaddon',
    version: pkg.version || '0.1.0',
    name: 'FebBox Addon',
    description:
      'Streams movies and TV shows from FebBox\'s catalog, using your own FebBox account to access it. ' +
      'You must supply your own FebBox `ui` token via the configuration page.',
    logo: baseUrl ? `${baseUrl}/assets/icon.png` : undefined,
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: !isConfigured,
    },
    stremioAddonsConfig: {
      issuer: 'https://stremio-addons.net',
      signature:
        'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..bJWQxRQZcfVHzDRQT_7LAw.haTd0Ks26xnMW-mWeq2tvpj3GhoVMhp4N9GDbk6LnadQl_75ICXEAlrOicJD7vLiR3b09vRLfCrdymmNucc-IrVxcc49toY-rO0LIyf0NKACmmFkeRQOcK90qdgcIE9u.lG09mNG-jJ4jwFVmjZH2jQ',
    },
  };
}

module.exports = { buildManifest };
