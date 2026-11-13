import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isDiscordActivity,
  deriveRoomCodeFromDiscord,
  discordActivityService,
} from './discordActivityService';
import { remapDiscordImageUrl } from '../utils/discordUrlMapper';

describe('discordActivityService & discordUrlMapper', () => {
  const originalWindow = (globalThis as any).window;

  function mockWindow(hostname = 'localhost', search = '') {
    (globalThis as any).window = {
      location: {
        hostname,
        search,
      },
      parent: null,
    };
  }

  afterEach(() => {
    (globalThis as any).window = originalWindow;
  });

  describe('isDiscordActivity', () => {
    it('returns false in standard browser environment', () => {
      mockWindow('albertorosati.github.io', '');
      expect(isDiscordActivity()).toBe(false);
    });

    it('returns true when hostname ends with discordsays.com', () => {
      mockWindow('1568251340294070313.discordsays.com', '');
      expect(isDiscordActivity()).toBe(true);
    });

    it('returns true when frame_id query parameter is present', () => {
      mockWindow('localhost', '?frame_id=e7b4e548-5c49-4364-bbcf-7127530e8c07');
      expect(isDiscordActivity()).toBe(true);
    });
  });

  describe('deriveRoomCodeFromDiscord', () => {
    it('preserves Discord instanceId or long snowflake as unique identifier', () => {
      const code = deriveRoomCodeFromDiscord('123456789012345678');
      expect(code).toBe('123456789012345678');
    });

    it('is completely deterministic for the same channel or instance ID', () => {
      const code1 = deriveRoomCodeFromDiscord('voice-channel-instance-987');
      const code2 = deriveRoomCodeFromDiscord('voice-channel-instance-987');
      expect(code1).toBe(code2);
    });

    it('handles empty or missing input gracefully with fallback', () => {
      const code = deriveRoomCodeFromDiscord('');
      expect(code.length).toBeGreaterThan(0);
    });
  });

  describe('remapDiscordImageUrl', () => {
    it('returns original URL when not running inside Discord', () => {
      mockWindow('albertorosati.github.io', '');
      const original = 'https://upload.wikimedia.org/wikipedia/commons/2/2d/Leo.jpg';
      expect(remapDiscordImageUrl(original)).toBe(original);
    });

    it('remaps upload.wikimedia.org when inside Discord Activity', () => {
      mockWindow('1568251340294070313.discordsays.com', '');
      const url = 'https://upload.wikimedia.org/wikipedia/commons/2/2d/Leo.jpg';
      const remapped = remapDiscordImageUrl(url);
      expect(remapped).toBe('/.proxy/upload-wikimedia/wikipedia/commons/2/2d/Leo.jpg');
    });

    it('remaps thumb.wikimedia.org when inside Discord Activity', () => {
      mockWindow('1568251340294070313.discordsays.com', '');
      const url = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/90/Brad.jpg/960px-Brad.jpg';
      const remapped = remapDiscordImageUrl(url);
      expect(remapped).toBe('/.proxy/thumb-wikimedia/wikipedia/commons/thumb/9/90/Brad.jpg/960px-Brad.jpg');
    });

    it('remaps wsrv.nl backup proxy when inside Discord Activity', () => {
      mockWindow('1568251340294070313.discordsays.com', '');
      const url = 'https://wsrv.nl/?url=test.jpg&w=960';
      const remapped = remapDiscordImageUrl(url);
      expect(remapped).toBe('/.proxy/wsrv/?url=test.jpg&w=960');
    });

    it('remaps newly added catalog image CDN hosts when inside Discord Activity', () => {
      mockWindow('1568251340294070313.discordsays.com', '');
      expect(
        remapDiscordImageUrl('https://shared.akamai.steamstatic.com/store_item_assets/123.jpg')
      ).toBe('/.proxy/steam-akamai/store_item_assets/123.jpg');
      expect(
        remapDiscordImageUrl('https://raw.githubusercontent.com/user/repo/main/img.png')
      ).toBe('/.proxy/github-raw/user/repo/main/img.png');
      expect(remapDiscordImageUrl('https://static.tvmaze.com/uploads/images/1.jpg')).toBe(
        '/.proxy/tvmaze/uploads/images/1.jpg'
      );
      expect(remapDiscordImageUrl('https://flagcdn.com/w320/it.png')).toBe(
        '/.proxy/flagcdn/w320/it.png'
      );
      expect(remapDiscordImageUrl('https://i.kym-cdn.com/entries/icons/abc.jpg')).toBe(
        '/.proxy/kym-cdn/entries/icons/abc.jpg'
      );
      expect(remapDiscordImageUrl('https://yt3.googleusercontent.com/ytc/avatar=s900')).toBe(
        '/.proxy/yt3/ytc/avatar=s900'
      );
    });

    it('leaves relative and data URLs untouched', () => {
      mockWindow('1568251340294070313.discordsays.com', '');
      expect(remapDiscordImageUrl('/logo.svg')).toBe('/logo.svg');
      expect(remapDiscordImageUrl('./banner.svg')).toBe('./banner.svg');
      expect(remapDiscordImageUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
    });
  });
});
