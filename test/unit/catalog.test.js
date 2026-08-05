'use strict';

const nock = require('nock');
const catalog = require('../../src/providers/febbox/catalog');
const { catalogCache } = require('../../src/cache/ttlCache');

afterEach(() => {
  nock.cleanAll();
  catalogCache.clear(); // catalogCache is a module-level singleton — tests must not leak state
});

const SEARCH_HTML = `
<html><body>
  <a href="/movie/m-example-movie-2020">Example Movie</a>
  <a href="/movie/m-example-movie-remake-1999">Example Movie Remake</a>
  <a href="/tv/t-example-show-2020">Example Show</a>
</body></html>
`;

function detailHtml({ id, type }) {
  return `
<html><body>
<script>
  $(".download_con .download_app").click(function(){
    $.ajax({
      url:'/index/share_link',
      type:'get',
      data:{'id':${id},'type':${type}},
      dataType:'json',
      success:function(data){}
    });
  });
</script>
</body></html>`;
}

describe('catalog (Problem A)', () => {
  test('search parses movie/tv result links out of the ShowBox HTML search page', async () => {
    nock('https://www.showbox.media').get('/search').query({ keyword: 'Example Movie' }).reply(200, SEARCH_HTML);

    const results = await catalog.search('Example Movie');
    expect(results).toEqual([
      { title: 'example movie', year: 2020, tmdbType: 'movie', path: '/movie/m-example-movie-2020' },
      { title: 'example movie remake', year: 1999, tmdbType: 'movie', path: '/movie/m-example-movie-remake-1999' },
      { title: 'example show', year: 2020, tmdbType: 'tv', path: '/tv/t-example-show-2020' },
    ]);
  });

  test('search caches results per normalized query — second call makes no HTTP request', async () => {
    const scope = nock('https://www.showbox.media').get('/search').query({ keyword: 'Example Movie' }).reply(200, SEARCH_HTML);
    const first = await catalog.search('Example Movie');
    expect(scope.isDone()).toBe(true);
    // No second interceptor registered — would throw ERR_NOCK_NO_MATCH if a real request were made.
    const second = await catalog.search('Example Movie');
    expect(second).toEqual(first);
  });

  test('search returns empty array on non-200', async () => {
    nock('https://www.showbox.media').get('/search').query({ keyword: 'Example Movie' }).reply(500, '');
    const results = await catalog.search('Example Movie');
    expect(results).toEqual([]);
  });

  test('search returns empty array for empty title', async () => {
    expect(await catalog.search('')).toEqual([]);
    expect(await catalog.search(null)).toEqual([]);
  });

  test('pickBestMatch picks the closest title+year+type match', () => {
    const results = [
      { title: 'Example Movie', year: 2020, tmdbType: 'movie', path: '/movie/m-example-movie-2020' },
      { title: 'Example Movie Remake', year: 1999, tmdbType: 'movie', path: '/movie/m-example-movie-remake-1999' },
      { title: 'Example Movie', year: 2020, tmdbType: 'tv', path: '/tv/t-example-movie-2020' }, // wrong type
    ];
    const match = catalog.pickBestMatch(results, { title: 'Example Movie', year: 2020, tmdbType: 'movie' });
    expect(match).toEqual(results[0]);
  });

  test('pickBestMatch returns null when nothing clears the similarity threshold', () => {
    const results = [{ title: 'Completely Unrelated Title', year: 2020, tmdbType: 'movie', path: '/movie/m-x-2020' }];
    const match = catalog.pickBestMatch(results, { title: 'Example Movie', year: 2020, tmdbType: 'movie' });
    expect(match).toBeNull();
  });

  test('getShowboxIdAndType extracts the literal id/type from the detail page markup', async () => {
    nock('https://www.showbox.media').get('/movie/m-example-movie-2020').reply(200, detailHtml({ id: 4059, type: 1 }));
    const idInfo = await catalog.getShowboxIdAndType('/movie/m-example-movie-2020');
    expect(idInfo).toEqual({ showboxId: '4059', boxType: 1 });
  });

  test('getShowboxIdAndType caches by path — second call makes no HTTP request', async () => {
    const scope = nock('https://www.showbox.media').get('/movie/m-example-movie-2020').reply(200, detailHtml({ id: 4059, type: 1 }));
    const first = await catalog.getShowboxIdAndType('/movie/m-example-movie-2020');
    expect(scope.isDone()).toBe(true);
    const second = await catalog.getShowboxIdAndType('/movie/m-example-movie-2020');
    expect(second).toEqual(first);
  });

  test('getShowboxIdAndType returns null when the page has no share_link markup', async () => {
    nock('https://www.showbox.media').get('/movie/m-no-match-2020').reply(200, '<html><body>nothing here</body></html>');
    const idInfo = await catalog.getShowboxIdAndType('/movie/m-no-match-2020');
    expect(idInfo).toBeNull();
  });

  test('getFebBoxShareKey parses the share key out of the showbox.media response', async () => {
    nock('https://www.showbox.media')
      .get('/index/share_link')
      .query({ id: '123', type: '1' })
      .reply(200, { code: 1, msg: 'success', data: { link: 'https://www.febbox.com/share/AbCdEfGh' } });

    const key = await catalog.getFebBoxShareKey('123', 1);
    expect(key).toBe('AbCdEfGh');
  });

  test('getFebBoxShareKey caches by id+type — second call makes no HTTP request', async () => {
    const scope = nock('https://www.showbox.media')
      .get('/index/share_link')
      .query({ id: '123', type: '1' })
      .reply(200, { code: 1, msg: 'success', data: { link: 'https://www.febbox.com/share/AbCdEfGh' } });
    const first = await catalog.getFebBoxShareKey('123', 1);
    expect(scope.isDone()).toBe(true);
    const second = await catalog.getFebBoxShareKey('123', 1);
    expect(second).toBe(first);
  });

  test('getFebBoxShareKey skipCache bypasses the cache and re-fetches', async () => {
    nock('https://www.showbox.media')
      .get('/index/share_link')
      .query({ id: '555', type: '1' })
      .reply(200, { code: 1, msg: 'success', data: { link: 'https://www.febbox.com/share/First' } });
    const first = await catalog.getFebBoxShareKey('555', 1);
    expect(first).toBe('First');

    nock('https://www.showbox.media')
      .get('/index/share_link')
      .query({ id: '555', type: '1' })
      .reply(200, { code: 1, msg: 'success', data: { link: 'https://www.febbox.com/share/Refreshed' } });
    const refreshed = await catalog.getFebBoxShareKey('555', 1, { skipCache: true });
    expect(refreshed).toBe('Refreshed');
  });

  test('getFebBoxShareKey returns null on a non-success response', async () => {
    nock('https://www.showbox.media')
      .get('/index/share_link')
      .query({ id: '999', type: '1' })
      .reply(200, { code: 0, msg: 'not found' });

    const key = await catalog.getFebBoxShareKey('999', 1);
    expect(key).toBeNull();
  });

  test('resolveShareKeyForTitle returns null when no confident ShowBox match exists', async () => {
    nock('https://www.showbox.media')
      .get('/search')
      .query({ keyword: 'Example Movie' })
      .reply(200, '<html><body><a href="/movie/m-totally-different-1950">Totally Different</a></body></html>');

    const key = await catalog.resolveShareKeyForTitle({ tmdbId: '1', tmdbType: 'movie', title: 'Example Movie', year: 2020 });
    expect(key).toBeNull();
  });

  test('resolveShareKeyForTitle chains search -> match -> detail page -> share_link end to end (mocked)', async () => {
    nock('https://www.showbox.media').get('/search').query({ keyword: 'Example Movie' }).reply(200, SEARCH_HTML);
    nock('https://www.showbox.media')
      .get('/movie/m-example-movie-2020')
      .reply(200, detailHtml({ id: 42, type: 1 }));
    nock('https://www.showbox.media')
      .get('/index/share_link')
      .query({ id: '42', type: '1' })
      .reply(200, { code: 1, msg: 'success', data: { link: 'https://www.febbox.com/share/ZzYyXxWw' } });
    nock('https://www.febbox.com').get('/share/ZzYyXxWw').reply(200, '<html>alive</html>');

    const key = await catalog.resolveShareKeyForTitle({ tmdbId: '1', tmdbType: 'movie', title: 'Example Movie', year: 2020 });
    expect(key).toBe('ZzYyXxWw');
  });

  test('resolveShareKeyForTitle falls through to the next ranked candidate when the top share is dead', async () => {
    nock('https://www.showbox.media')
      .get('/search')
      .query({ keyword: 'Example Movie' })
      .reply(200, `
        <html><body>
          <a href="/movie/m-example-movie-2020">Example Movie</a>
          <a href="/movie/m-example-movie-again-2020">Example Movie Again</a>
        </body></html>
      `);
    nock('https://www.showbox.media').get('/movie/m-example-movie-2020').reply(200, detailHtml({ id: 1, type: 1 }));
    nock('https://www.showbox.media')
      .get('/index/share_link')
      .query({ id: '1', type: '1' })
      .reply(200, { code: 1, msg: 'success', data: { link: 'https://www.febbox.com/share/DeadShare' } });
    // Dead share: share_link succeeds but the share page itself 404s, and
    // the refresh-and-retry attempt (skipCache:true) returns the same dead
    // link again — so this candidate is exhausted and the next is tried.
    nock('https://www.febbox.com').get('/share/DeadShare').times(2).reply(404);
    nock('https://www.showbox.media')
      .get('/index/share_link')
      .query({ id: '1', type: '1' })
      .reply(200, { code: 1, msg: 'success', data: { link: 'https://www.febbox.com/share/DeadShare' } });

    nock('https://www.showbox.media').get('/movie/m-example-movie-again-2020').reply(200, detailHtml({ id: 2, type: 1 }));
    nock('https://www.showbox.media')
      .get('/index/share_link')
      .query({ id: '2', type: '1' })
      .reply(200, { code: 1, msg: 'success', data: { link: 'https://www.febbox.com/share/LiveShare' } });
    nock('https://www.febbox.com').get('/share/LiveShare').reply(200, '<html>alive</html>');

    const key = await catalog.resolveShareKeyForTitle({ tmdbId: '1', tmdbType: 'movie', title: 'Example Movie', year: 2020 });
    expect(key).toBe('LiveShare');
  });

  test('resolveShareKeyForTitle returns null when every ranked candidate is dead', async () => {
    nock('https://www.showbox.media')
      .get('/search')
      .query({ keyword: 'Example Movie' })
      .reply(200, SEARCH_HTML);
    nock('https://www.showbox.media').get('/movie/m-example-movie-2020').reply(200, detailHtml({ id: 1, type: 1 }));
    nock('https://www.showbox.media')
      .get('/index/share_link')
      .query({ id: '1', type: '1' })
      .times(2)
      .reply(200, { code: 1, msg: 'success', data: { link: 'https://www.febbox.com/share/AlwaysDead' } });
    nock('https://www.febbox.com').get('/share/AlwaysDead').times(2).reply(404);

    const key = await catalog.resolveShareKeyForTitle({ tmdbId: '1', tmdbType: 'movie', title: 'Example Movie', year: 2020 });
    expect(key).toBeNull();
  });

  test('resolveShareKeyForTitle returns null without a title', async () => {
    expect(await catalog.resolveShareKeyForTitle({})).toBeNull();
    expect(await catalog.resolveShareKeyForTitle(null)).toBeNull();
  });
});
