import { isDiscordActivity } from '../services/discordActivityService';

/**
 * Rewrites an external image URL to route through Discord's application proxy mappings
 * when running inside an activity iframe on *.discordsays.com.
 *
 * When running in standard web mode, returns the original URL untouched.
 */
export function remapDiscordImageUrl(url: string): string {
  if (!url || typeof url !== 'string') return url;
  if (!isDiscordActivity()) return url;

  // Don't modify already proxied, relative, or data URLs
  if (
    url.startsWith('/') ||
    url.startsWith('./') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  ) {
    return url;
  }

  try {
    const parsed = new URL(url);

    const hostMap: Record<string, string> = {
      'upload.wikimedia.org': '/.proxy/upload-wikimedia',
      'thumb.wikimedia.org': '/.proxy/thumb-wikimedia',
      'wsrv.nl': '/.proxy/wsrv',
      'shared.akamai.steamstatic.com': '/.proxy/steam-akamai',
      'raw.githubusercontent.com': '/.proxy/github-raw',
      'static.tvmaze.com': '/.proxy/tvmaze',
      'flagcdn.com': '/.proxy/flagcdn',
      'i.kym-cdn.com': '/.proxy/kym-cdn',
      'yt3.googleusercontent.com': '/.proxy/yt3',
    };

    const proxyPrefix = hostMap[parsed.hostname];
    if (proxyPrefix) {
      return `${proxyPrefix}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // If URL parsing fails, return original
  }

  return url;
}
