// Licence helpers shared by built-in sources.

/** "http://creativecommons.org/licenses/by-nc-sa/4.0/" -> "CC BY-NC-SA 4.0" */
export function ccLicenceName(url: string): string {
  const m = /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/(\d(?:\.\d)?)/i.exec(url);
  if (!m) return 'See licence';
  if (m[1] === 'publicdomain') return m[2] === 'zero' ? `CC0 ${m[3]}` : `Public Domain Mark ${m[3]}`;
  return `CC ${m[2]!.toUpperCase()} ${m[3]}`;
}
