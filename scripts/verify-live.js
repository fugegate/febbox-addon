'use strict';

/**
 * Standalone manual verification against a real FebBox account/share.
 *
 * Reads FEBBOX_UI_TOKEN and FEBBOX_TEST_SHARE from the environment.
 * Never prints the token, cookies, signed query parameters, or full
 * playback URLs — only the sanitized fields listed below.
 *
 * Run with:
 *   FEBBOX_UI_TOKEN=<token> FEBBOX_TEST_SHARE=<share-url-or-key> node scripts/verify-live.js
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const token = process.env.FEBBOX_UI_TOKEN;
const shareInput = process.env.FEBBOX_TEST_SHARE;

function fail(msg) {
  console.error(`[verify-live] FAIL: ${msg}`);
  process.exitCode = 1;
}

function sanitizedUrlInfo(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return { hostname: u.hostname, protocol: u.protocol.replace(':', '') };
  } catch (e) {
    return { hostname: 'unparsable', protocol: 'unknown' };
  }
}

/** Minimal range request against a media URL; never logs the URL itself. */
function probeMediaUrl(rawUrl) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return resolve({ ok: false, status: null, contentType: null });
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: 'GET',
        headers: { Range: 'bytes=0-1023' },
        timeout: 15000,
      },
      (res) => {
        // Drain and destroy immediately — we only need headers/status.
        res.destroy();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          contentType: res.headers['content-type'] || null,
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: null, contentType: null });
    });
    req.on('error', () => {
      resolve({ ok: false, status: null, contentType: null });
    });
    req.end();
  });
}

async function main() {
  if (!token) {
    fail('FEBBOX_UI_TOKEN not set in environment. Nothing to verify.');
    return;
  }
  if (!shareInput) {
    fail('FEBBOX_TEST_SHARE not set in environment. Cannot exercise share resolution.');
    return;
  }

  const client = require('../src/providers/febbox/client');
  const resolver = require('../src/providers/febbox/resolver');

  // Step 1: validate token via quota lookup, without printing it.
  let quota;
  try {
    quota = await client.getQuota({ token });
    console.log(`[verify-live] token validation: OK (isVip=${quota.isVip}, remainingMB=${quota.remainingMB})`);
  } catch (err) {
    fail(`token validation failed: ${err.code || err.message}`);
    return;
  }

  // Step 2: parse the supplied share.
  const shareKey = resolver.extractShareKey(shareInput);
  if (!shareKey) {
    fail('could not parse a share key from FEBBOX_TEST_SHARE');
    return;
  }
  console.log(`[verify-live] share parsed: shareKey length=${shareKey.length}`);

  // Step 3: list available video files.
  let files;
  try {
    files = await resolver.listAllFiles({ token, shareKey });
  } catch (err) {
    fail(`listing files failed: ${err.code || err.message}`);
    return;
  }
  const videoFiles = files.filter((f) => resolver.isLikelyVideo(f.name));
  console.log(`[verify-live] file listing: totalEntries=${files.length} videoFiles=${videoFiles.length}`);
  if (videoFiles.length === 0) {
    fail('no video files found in share — cannot proceed to resolution');
    return;
  }

  // Step 4: resolve at least one direct playable URL.
  let streams;
  try {
    streams = await resolver.resolveFileStreams({
      token,
      shareKey,
      fid: videoFiles[0].fid,
      fileName: videoFiles[0].name,
    });
  } catch (err) {
    fail(`resolving streams failed: ${err.code || err.message}`);
    return;
  }
  if (!streams || streams.length === 0) {
    fail('resolver returned zero playable streams for the first video file');
    return;
  }

  const qualities = streams.map((s) => s.quality);
  const sizes = streams.map((s) => s.size);
  console.log(`[verify-live] resolution: sourceCount=${streams.length} qualities=[${qualities.join(', ')}] sizes=[${sizes.join(', ')}]`);

  // Step 5: HEAD/range-probe the first resolved URL to confirm it's live.
  const first = streams[0];
  const urlInfo = sanitizedUrlInfo(first.url);
  const probe = await probeMediaUrl(first.url);

  console.log('--- SANITIZED RESULT ---');
  console.log(`http_status: ${probe.status}`);
  console.log(`file_count: ${videoFiles.length}`);
  console.log(`qualities: ${qualities.join(', ')}`);
  console.log(`sizes: ${sizes.join(', ')}`);
  console.log(`media_hostname: ${urlInfo.hostname}`);
  console.log(`content_type: ${probe.contentType}`);
  console.log(`probe_ok: ${probe.ok}`);

  if (!probe.ok) {
    fail('media URL did not respond successfully to range probe — resolution alone is NOT sufficient proof of playback.');
    return;
  }

  console.log('[verify-live] PASS: token valid, share parsed, files listed, stream resolved, media URL responded.');
}

main().catch((err) => {
  fail(`unexpected error: ${err && err.code ? err.code : (err && err.message) || String(err)}`);
});
