'use strict';

const nock = require('nock');
const { convertImdbToTmdb, getAlternativeTitles } = require('../../src/metadata/tmdb');
const { catalogCache } = require('../../src/cache/ttlCache');

afterEach(() => {
  nock.cleanAll();
  catalogCache.clear();
});

describe('tmdb metadata + caching', () => {
  test('convertImdbToTmdb resolves a movie and caches the result', async () => {
    const scope = nock('https://api.themoviedb.org')
      .get('/3/find/tt1234567')
      .query(true)
      .reply(200, { movie_results: [{ id: 42, title: 'Example', release_date: '2020-05-01' }], tv_results: [] });

    const first = await convertImdbToTmdb('tt1234567', 'movie', 'fake-key');
    expect(first).toEqual({ tmdbId: '42', tmdbType: 'movie', title: 'Example', year: 2020 });
    expect(scope.isDone()).toBe(true);

    // Second call must be served from cache — no second nock interceptor
    // registered, so a real request here would throw ERR_NOCK_NO_MATCH.
    const second = await convertImdbToTmdb('tt1234567', 'movie', 'fake-key');
    expect(second).toEqual(first);
  });

  test('convertImdbToTmdb does not cache a miss', async () => {
    nock('https://api.themoviedb.org').get('/3/find/tt9999999').query(true).reply(200, { movie_results: [], tv_results: [] });
    const result = await convertImdbToTmdb('tt9999999', 'movie', 'fake-key');
    expect(result).toBeNull();
  });

  test('getAlternativeTitles filters to ASCII-only titles, dedupes, and caches', async () => {
    const scope = nock('https://api.themoviedb.org')
      .get('/3/movie/42/alternative_titles')
      .query(true)
      .reply(200, {
        titles: [
          { title: '기생충', iso_3166_1: 'KR' },
          { title: 'Gisaengchung', iso_3166_1: 'KR' },
          { title: 'Gisaengchung', iso_3166_1: 'CL' }, // duplicate, different country
        ],
      });

    const first = await getAlternativeTitles('42', 'movie', 'fake-key');
    expect(first).toEqual(['Gisaengchung']);
    expect(scope.isDone()).toBe(true);

    const second = await getAlternativeTitles('42', 'movie', 'fake-key');
    expect(second).toEqual(['Gisaengchung']);
  });
});
