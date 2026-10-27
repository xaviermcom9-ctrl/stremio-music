// Matching the same artist/album across sources: MusicBrainz ids when both sides have one,
// otherwise normalised names ("The Beatles" = "beatles", "Sigur Rós" = "Sigur Ros").

export function norm(s: string | undefined | null): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/^the\s+|,\s*the$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Is `candidate` the same entity? Different MBIDs: no. Same MBID: yes. Otherwise its name must be
 * one of the known names (the entity's own name plus MusicBrainz aliases).
 */
export function isSame(known: { mbid?: string; names: Set<string> }, candidate: { mbid?: string; name: string }): boolean {
  if (known.mbid && candidate.mbid) return known.mbid === candidate.mbid;
  const n = norm(candidate.name);
  return n !== '' && known.names.has(n);
}

/** Album identity: release MBID, else artist + title. */
export function albumKey(a: { name: string; music?: { mbid?: string; artist?: string } }, fallbackArtist?: string): string {
  return a.music?.mbid ? `mb:${a.music.mbid}` : `${norm(a.music?.artist ?? fallbackArtist)}/${norm(a.name)}`;
}
