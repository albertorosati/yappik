import { describe, it, expect, beforeEach } from 'vitest';
import {
  blacklistService,
  getCanonicalImageKey,
} from './blacklistService';

describe('blacklistService', () => {
  beforeEach(() => {
    blacklistService.clearUserFlags();
  });

  describe('getCanonicalImageKey', () => {
    it('estrae la stessa chiave canonica per thumbnail e URL originario di Wikimedia Commons', () => {
      const orig =
        'https://upload.wikimedia.org/wikipedia/commons/c/ce/Tetraodon-hispidus.jpg';
      const thumb =
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/ce/Tetraodon-hispidus.jpg/960px-Tetraodon-hispidus.jpg';

      expect(getCanonicalImageKey(orig)).toBe('commons:tetraodon-hispidus.jpg');
      expect(getCanonicalImageKey(thumb)).toBe('commons:tetraodon-hispidus.jpg');
      expect(getCanonicalImageKey(orig)).toBe(getCanonicalImageKey(thumb));
    });

    it('gestisce URL con parametri di query e hash', () => {
      const urlWithQuery = 'https://example.com/photos/dog.jpg?v=2#details';
      expect(getCanonicalImageKey(urlWithQuery)).toBe(
        'https://example.com/photos/dog.jpg'
      );
    });
  });

  describe('isBlacklisted', () => {
    it('riconosce gli URL presenti nella blacklist statica (anche come thumbnail)', () => {
      const thumbUrl =
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/ce/Tetraodon-hispidus.jpg/960px-Tetraodon-hispidus.jpg';
      expect(blacklistService.isBlacklisted(thumbUrl)).toBe(true);

      const collageThumb =
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c7/Starfish_montage.png/960px-Starfish_montage.png';
      expect(blacklistService.isBlacklisted(collageThumb)).toBe(true);

      // Copertine con titoli spoiler supereroi bloccate
      const spidermanCover =
        'https://upload.wikimedia.org/wikipedia/it/8/82/Copertina_Uomo_Ragno_MI_430.png';
      expect(blacklistService.isBlacklisted(spidermanCover)).toBe(true);

      const batmanCover =
        'https://upload.wikimedia.org/wikipedia/it/1/19/Batman_3_variant.jpg';
      expect(blacklistService.isBlacklisted(batmanCover)).toBe(true);

      // Banner schiacciati (library_hero 3.1:1) dei videogiochi bloccati
      const gtaBanner =
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/271590/library_hero.jpg';
      expect(blacklistService.isBlacklisted(gtaBanner)).toBe(true);

      const rdr2Banner =
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1174180/library_hero.jpg';
      expect(blacklistService.isBlacklisted(rdr2Banner)).toBe(true);

      // Omonimi errati (civetta per Atena, negozio di lusso per Ermes) bloccati
      const athenaOwl =
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a9/Mochuelo_Com%C3%BAn_%28_Athene_noctua_%29%281%29.jpg/960px-Mochuelo_Com%C3%BAn_%28_Athene_noctua_%29%281%29.jpg';
      expect(blacklistService.isBlacklisted(athenaOwl)).toBe(true);

      const hermesStore =
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/25/Rue_du_Faubourg-Saint-Honor%C3%A9%2C_Paris_May_2006.jpg/960px-Rue_du_Faubourg-Saint-Honor%C3%A9%2C_Paris_May_2006.jpg';
      expect(blacklistService.isBlacklisted(hermesStore)).toBe(true);

      // Snack/bibite errati (edificio PepsiCo HQ, film Mon Chéri, meme Doritos) bloccati
      const pepsiHQ =
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/93/PepsiCoHQPurchaseNY.jpg/960px-PepsiCoHQPurchaseNY.jpg';
      expect(blacklistService.isBlacklisted(pepsiHQ)).toBe(true);

      const monCheriMovie =
        'https://upload.wikimedia.org/wikipedia/commons/7/7a/C%27est_La_Vie%2C_Mon_Ch%C3%A9ri.jpg';
      expect(blacklistService.isBlacklisted(monCheriMovie)).toBe(true);

      const doritoPope =
        'https://upload.wikimedia.org/wikipedia/commons/f/f0/Geoff_Keighley_-_19th_Annual_Game_Developers_Choice_Awards_%28D5X_8647%29_%28cropped%29.jpg';
      expect(blacklistService.isBlacklisted(doritoPope)).toBe(true);

      const cleanPhoto =
        'https://upload.wikimedia.org/wikipedia/commons/1/12/Living_clean_fish.jpg';
      expect(blacklistService.isBlacklisted(cleanPhoto)).toBe(false);
    });

    it('permette all utente di segnalare una foto e la blocca istantaneamente', () => {
      const badPhoto =
        'https://upload.wikimedia.org/wikipedia/commons/a/ab/Dissected_frog_jar.jpg';
      expect(blacklistService.isBlacklisted(badPhoto)).toBe(false);

      blacklistService.flagImage(badPhoto, {
        itemId: 'frog-1',
        answer: 'Rana',
        reason: 'dissection jar',
      });

      expect(blacklistService.isBlacklisted(badPhoto)).toBe(true);
      // Il thumbnail corrispondente deve risultare bloccato automaticamente
      const badThumb =
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Dissected_frog_jar.jpg/960px-Dissected_frog_jar.jpg';
      expect(blacklistService.isBlacklisted(badThumb)).toBe(true);

      expect(blacklistService.getFlaggedCount()).toBe(1);
      const flagged = blacklistService.getFlaggedImages();
      expect(flagged[0].answer).toBe('Rana');
      expect(flagged[0].itemId).toBe('frog-1');
    });

    it('permette di rimuovere la segnalazione o ripulirle tutte', () => {
      const badPhoto = 'https://example.com/bad1.jpg';
      blacklistService.flagImage(badPhoto);
      expect(blacklistService.isBlacklisted(badPhoto)).toBe(true);

      blacklistService.unflagImage(badPhoto);
      expect(blacklistService.isBlacklisted(badPhoto)).toBe(false);

      blacklistService.flagImage(badPhoto);
      expect(blacklistService.getFlaggedCount()).toBe(1);
      blacklistService.clearUserFlags();
      expect(blacklistService.getFlaggedCount()).toBe(0);
      expect(blacklistService.isBlacklisted(badPhoto)).toBe(false);
    });

    it('esporta il JSON della blacklist integrando le segnalazioni utente', () => {
      const userPhoto = 'https://example.com/user_bad.jpg';
      blacklistService.flagImage(userPhoto, { answer: 'Esempio' });

      const exportedJson = blacklistService.exportBlacklistJson();
      const parsed = JSON.parse(exportedJson);

      expect(parsed.version).toBe(1);
      expect(parsed.blacklistedUrls).toContain(userPhoto);
      expect(parsed.reports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: userPhoto,
            answer: 'Esempio',
          }),
        ])
      );
    });

    it('unwraps wsrv.nl backup proxy URLs so only the inner image URL is flagged', () => {
      const innerA = 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Bad.jpg';
      const innerB = 'https://upload.wikimedia.org/wikipedia/commons/b/b2/Good.jpg';
      const wrappedBad = `https://wsrv.nl/?url=${encodeURIComponent(innerA)}&w=960`;
      const wrappedGood = `https://wsrv.nl/?url=${encodeURIComponent(innerB)}&w=960`;

      blacklistService.flagImage(wrappedBad, { answer: 'Test' });
      expect(blacklistService.isBlacklisted(wrappedBad)).toBe(true);
      expect(blacklistService.isBlacklisted(innerA)).toBe(true);
      expect(blacklistService.isBlacklisted(wrappedGood)).toBe(false);
    });
  });
});
