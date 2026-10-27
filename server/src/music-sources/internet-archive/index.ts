// Internet Archive (archive.org): Live Music Archive, netlabels, 78 RPM records and more. No API key.
import { createArchiveSource, quote } from './archive.js';

/** music collections searched and used for "popular" (not audiobooks, podcasts or radio shows) */
const MUSIC_COLLECTIONS = '(etree OR netlabels OR georgeblood OR audio_music)';

export default createArchiveSource({
  id: 'internet-archive',
  name: 'Internet Archive',
  description: 'Live concert recordings (Live Music Archive), netlabel releases, 78 RPM records and more from archive.org. No account needed.',
  attribution: 'Music from the Internet Archive (archive.org); rights and licences per item',
  origin: 'Internet Archive',
  testQuery: 'collection:etree AND mediatype:etree',
  catalogs: [
    {
      def: { id: 'popular', name: 'Popular this week', kind: 'album', extra: [{ name: 'skip' }] },
      query: () => `collection:${MUSIC_COLLECTIONS} AND mediatype:(audio OR etree)`,
      sort: 'week desc',
    },
    {
      def: { id: 'lma-recent', name: 'Live Music Archive: recently added', kind: 'album', extra: [{ name: 'skip' }] },
      query: () => 'collection:etree AND mediatype:etree',
      sort: 'publicdate desc',
    },
    {
      def: { id: 'lma-bands', name: 'Live Music Archive: bands', kind: 'artist', extra: [{ name: 'skip' }] },
      query: () => 'collection:etree AND mediatype:collection',
      sort: 'downloads desc',
    },
    {
      def: { id: 'netlabels', name: 'Netlabel releases', kind: 'album', extra: [{ name: 'genre' }, { name: 'skip' }] },
      query: (req) => `collection:netlabels AND mediatype:audio${req.genre ? ` AND subject:(${quote(req.genre)})` : ''}`,
      sort: 'downloads desc',
    },
    {
      def: { id: '78rpm', name: '78 RPM records', kind: 'album', extra: [{ name: 'skip' }] },
      query: () => 'collection:georgeblood AND mediatype:audio',
      sort: 'downloads desc',
    },
    {
      def: { id: 'search', name: 'Search', extra: [{ name: 'search', isRequired: true }, { name: 'skip' }] },
      query: (req) => {
        const term = quote(req.search ?? '');
        return `(title:(${term}) OR creator:(${term})) AND collection:${MUSIC_COLLECTIONS} AND mediatype:(audio OR etree OR collection)`;
      },
      sort: 'downloads desc',
    },
  ],
});
