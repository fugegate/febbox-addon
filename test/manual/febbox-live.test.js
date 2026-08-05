'use strict';

/**
 * Opt-in manual integration test against real FebBox.
 *
 * Reads FEBBOX_UI_TOKEN from the environment. Never prints the token.
 * Auto-skips (test passes trivially as "skipped") when no token is present,
 * so this never blocks `npm test` in CI or for contributors without a
 * FebBox account.
 *
 * Run with:  FEBBOX_UI_TOKEN=<your-token> npx jest test/manual/febbox-live.test.js
 */

const token = process.env.FEBBOX_UI_TOKEN;
const describeOrSkip = token ? describe : describe.skip;

describeOrSkip('FebBox live integration (manual, opt-in)', () => {
  jest.setTimeout(30000);

  test('quota lookup succeeds and reports only sanitized fields', async () => {
    const { getQuota } = require('../../src/providers/febbox/client');
    const quota = await getQuota({ token });
    // eslint-disable-next-line no-console
    console.log(
      `[manual-live] quota check: remainingMB=${quota.remainingMB} isVip=${quota.isVip} ` +
      `(token not printed)`
    );
    expect(typeof quota.remainingMB).toBe('number');
  });

  test('a known public share resolves to at least one playable quality (if still online)', async () => {
    const resolver = require('../../src/providers/febbox/resolver');
    // A share URL the user provides via FEBBOX_TEST_SHARE env var; if not
    // given, this sub-test is skipped rather than hardcoding a specific
    // share that may vanish and break the run.
    const shareUrl = process.env.FEBBOX_TEST_SHARE;
    if (!shareUrl) {
      // eslint-disable-next-line no-console
      console.log('[manual-live] FEBBOX_TEST_SHARE not set, skipping share resolution sub-test.');
      return;
    }
    const shareKey = resolver.extractShareKey(shareUrl);
    const streams = await resolver.resolveMovie({ token, shareKey });
    const qualities = streams.map((s) => s.quality);
    const hostnames = streams.map((s) => {
      try {
        return new URL(s.url).hostname;
      } catch (e) {
        return 'unparsable';
      }
    });
    // eslint-disable-next-line no-console
    console.log(`[manual-live] source count=${streams.length} qualities=${qualities.join(',')} hosts=${hostnames.join(',')}`);
    expect(streams.length).toBeGreaterThan(0);
  });
});
