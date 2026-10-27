// Free Music Archive, via its mirror on archive.org: FMA's own API was retired (its /api endpoints
// return 404) and the live site has no data API, so this uses the "freemusicarchive" collection on
// archive.org: about 16,800 releases added 2011-2018, frozen since. Licences and the original FMA
// page are shown per release.
import { createArchiveSource, quote } from '../internet-archive/archive.js';

const FMA = 'collection:freemusicarchive AND mediatype:audio';

export default createArchiveSource({
  id: 'free-music-archive',
  name: 'Free Music Archive',
  description: 'Creative Commons music from the Free Music Archive (freemusicarchive.org), via its archive.org mirror of releases up to 2018.',
  attribution: 'Music from the Free Music Archive, mirrored by the Internet Archive; licence per release',
  origin: 'Free Music Archive',
  testQuery: FMA,
  catalogs: [
    { def: { id: 'popular', name: 'Most downloaded', kind: 'album', extra: [{ name: 'skip' }] }, query: () => FMA, sort: 'downloads desc' },
    {
      def: { id: 'remix', name: 'Remix-friendly (no NoDerivs licence)', kind: 'album', extra: [{ name: 'skip' }] },
      query: () => `${FMA} AND licenseurl:* AND NOT licenseurl:*-nd*`,
      sort: 'downloads desc',
    },
    { def: { id: 'latest', name: 'Latest in the archive (2018)', kind: 'album', extra: [{ name: 'skip' }] }, query: () => FMA, sort: 'publicdate desc' },
    {
      def: { id: 'search', name: 'Search', kind: 'album', extra: [{ name: 'search', isRequired: true }, { name: 'skip' }] },
      query: (req) => {
        const term = quote(req.search ?? '');
        return `(title:(${term}) OR creator:(${term})) AND ${FMA}`;
      },
      sort: 'downloads desc',
    },
  ],
});
