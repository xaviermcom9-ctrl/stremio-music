// Minimal Lidarr and Prowlarr API v1 clients (X-Api-Key). Verified against Lidarr 3.1 and Prowlarr 2.6.

export class ArrError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

class Arr {
  constructor(
    private name: string,
    private opts: { url: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number },
  ) {}

  async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const base = this.opts.url.replace(/\/+$/, '');
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${base}/api/v1/${path}`, {
        method: init.method ?? 'GET',
        headers: { 'x-api-key': this.opts.apiKey, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new ArrError(`${this.name} is not reachable at ${base} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.status === 401) throw new ArrError(`${this.name} rejected the API key`, 401);
    const text = await res.text();
    if (!res.ok) {
      // Lidarr/Prowlarr errors: {message} or a list of validation failures [{errorMessage}]
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string } | { errorMessage?: string }[];
        detail = Array.isArray(j) ? j.map((e) => e.errorMessage).filter(Boolean).join('; ') : (j.message ?? detail);
      } catch {
        // not JSON
      }
      throw new ArrError(`${this.name}: ${detail || `HTTP ${res.status}`}`, res.status);
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}

export interface LidarrImage {
  coverType: string;
  url?: string;
  remoteUrl?: string;
}

export interface LidarrAlbum {
  id?: number;
  title: string;
  foreignAlbumId: string;
  artistId?: number;
  monitored: boolean;
  albumType?: string;
  secondaryTypes?: string[];
  releaseDate?: string;
  images?: LidarrImage[];
  remoteCover?: string;
  statistics?: { trackFileCount: number; trackCount: number; totalTrackCount: number; percentOfTracks: number; sizeOnDisk: number };
  artist: { artistName: string; foreignArtistId: string; id?: number; [k: string]: unknown };
  [k: string]: unknown;
}

export interface LidarrQueueItem {
  albumId?: number;
  size: number;
  sizeleft: number;
  status: string;
  trackedDownloadState?: string;
  trackedDownloadStatus?: string;
  errorMessage?: string;
  statusMessages?: { title?: string; messages?: string[] }[];
  title?: string;
}

export class Lidarr extends Arr {
  constructor(opts: { url: string; apiKey: string; fetch?: typeof fetch }) {
    super('Lidarr', opts);
  }

  status = () => this.call<{ version: string; appName: string }>('system/status');
  rootFolders = () => this.call<{ id: number; path: string; freeSpace?: number }[]>('rootfolder');
  qualityProfiles = () => this.call<{ id: number; name: string }[]>('qualityprofile');
  metadataProfiles = () => this.call<{ id: number; name: string }[]>('metadataprofile');

  async lookupAlbums(term: string): Promise<LidarrAlbum[]> {
    const r = await this.call<LidarrAlbum[] | unknown>(`album/lookup?term=${encodeURIComponent(term)}`);
    // Lidarr's metadata server sometimes fails a search; Lidarr then answers with an error object
    if (!Array.isArray(r)) throw new ArrError('Lidarr’s metadata server didn’t answer this search; try again or rephrase it');
    return r as LidarrAlbum[];
  }

  album = (id: number) => this.call<LidarrAlbum>(`album/${id}`);
  monitor = (albumIds: number[], monitored: boolean) => this.call('album/monitor', { method: 'PUT', body: { albumIds, monitored } });
  search = (albumIds: number[]) => this.call('command', { method: 'POST', body: { name: 'AlbumSearch', albumIds } });

  /** Adds an album (and its artist when new: only this album monitored, nothing else), and searches for it. */
  addAlbum(album: LidarrAlbum, o: { rootFolderPath: string; qualityProfileId: number; metadataProfileId: number }) {
    return this.call<LidarrAlbum>('album', {
      method: 'POST',
      body: {
        ...album,
        monitored: true,
        addOptions: { searchForNewAlbum: true },
        artist: {
          ...album.artist,
          ...o,
          monitored: true,
          monitorNewItems: 'none',
          addOptions: { monitor: 'none', albumsToMonitor: [album.foreignAlbumId], searchForMissingAlbums: false },
        },
      },
    });
  }

  async queue(): Promise<LidarrQueueItem[]> {
    const r = await this.call<{ records: LidarrQueueItem[] }>('queue?pageSize=500&includeAlbum=false&includeUnknownArtistItems=false');
    return r.records ?? [];
  }
}

export class Prowlarr extends Arr {
  constructor(opts: { url: string; apiKey: string; fetch?: typeof fetch }) {
    super('Prowlarr', opts);
  }

  status = () => this.call<{ version: string }>('system/status');
  indexers = () => this.call<{ id: number; name: string; enable: boolean; protocol: string }[]>('indexer');
  indexerStatus = () => this.call<{ indexerId: number; disabledTill?: string; mostRecentFailure?: string }[]>('indexerstatus');
  applications = () => this.call<{ id: number; name: string; implementation: string; syncLevel: string; fields?: { name: string; value?: unknown }[] }[]>('applications');
  syncIndexers = () => this.call('command', { method: 'POST', body: { name: 'ApplicationIndexerSync' } });
}
