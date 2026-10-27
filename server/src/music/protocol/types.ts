// Ported from Resonance (~/resonance/server/src/protocol/types.ts).
// Types for the Stremio addon protocol, as described in
// stremio-addon-sdk/docs/api/responses/*.md. Only the fields Resonance reads are
// typed precisely; everything else is passed through untouched.

export type ResourceName = 'catalog' | 'meta' | 'stream' | 'subtitles' | (string & {});

export interface ExtraProp {
  name: string;
  isRequired?: boolean;
  options?: string[];
  optionsLimit?: number;
}

export interface ManifestCatalog {
  type: string;
  id: string;
  name?: string;
  extra?: ExtraProp[];
  /** Legacy short notation; normalized into `extra` by validateManifest. */
  extraSupported?: string[];
  extraRequired?: string[];
}

export interface ResourceDescriptor {
  name: ResourceName;
  types?: string[];
  idPrefixes?: string[];
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  resources: (ResourceName | ResourceDescriptor)[];
  types: string[];
  catalogs: ManifestCatalog[];
  idPrefixes?: string[] | null;
  logo?: string;
  background?: string;
  behaviorHints?: {
    adult?: boolean;
    p2p?: boolean;
    configurable?: boolean;
    configurationRequired?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Cache-related properties an addon may add to any resource response. */
export interface CacheProps {
  cacheMaxAge?: number;
  staleRevalidate?: number;
  staleError?: number;
}

export interface MetaPreview {
  id: string;
  type: string;
  name: string;
  poster?: string;
  posterShape?: 'square' | 'poster' | 'landscape';
  genres?: string[];
  releaseInfo?: string;
  description?: string;
  links?: MetaLink[];
  [k: string]: unknown;
}

/** docs/api/responses/meta.md#meta-link-object */
export interface MetaLink {
  name: string;
  category: string;
  url: string;
}

export interface Video {
  id: string;
  title: string;
  released?: string;
  thumbnail?: string;
  streams?: Stream[];
  available?: boolean;
  episode?: number;
  season?: number;
  overview?: string;
  runtime?: string;
  [k: string]: unknown;
}

export interface Meta extends MetaPreview {
  background?: string;
  logo?: string;
  videos?: Video[];
  runtime?: string;
  behaviorHints?: { defaultVideoId?: string; [k: string]: unknown };
}

export interface Stream {
  url?: string;
  ytId?: string;
  infoHash?: string;
  fileIdx?: number;
  externalUrl?: string;
  name?: string;
  /** Deprecated in favour of `description`, still widely used. */
  title?: string;
  description?: string;
  sources?: string[];
  behaviorHints?: {
    notWebReady?: boolean;
    bingeGroup?: string;
    proxyHeaders?: { request?: Record<string, string>; response?: Record<string, string> };
    videoSize?: number;
    filename?: string;
    countryWhitelist?: string[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface CatalogResponse extends CacheProps { metas: MetaPreview[] }
export interface MetaResponse extends CacheProps { meta: Meta | null }
export interface StreamResponse extends CacheProps { streams: Stream[] }

/** Extra args for catalog requests (search, skip, genre, ...). */
export type ExtraArgs = Record<string, string | number | undefined>;
