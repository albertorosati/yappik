import { describe, it, expect, beforeEach } from 'vitest';
import {
  getItemImagePool,
  getRandomItemImage,
  prepareArenaDeck,
  markItemSeen,
  clearSeenItemsHistory,
} from './itemUtils';
import { DuelItem } from '../types/game';
import { blacklistService } from '../services/blacklistService';

describe('itemUtils - Multi-Photo Anti-Memorization and Blacklist Filtering', () => {
  beforeEach(() => {
    blacklistService.clearUserFlags();
    clearSeenItemsHistory();
  });

  const itemSingle: DuelItem = {
    id: 'single-1',
    answer: 'Leonardo DiCaprio',
    aliases: ['dicaprio'],
    imageUrl: 'https://example.com/leo1.jpg',
  };

  const itemMulti: DuelItem = {
    id: 'multi-1',
    answer: 'Brad Pitt',
    aliases: ['pitt'],
    imageUrl: 'https://example.com/brad1.jpg',
    imageUrls: [
      'https://example.com/brad1.jpg',
      'https://example.com/brad2.jpg',
      'https://example.com/brad3.jpg',
    ],
  };

  it('estrae il pool di immagini corretto e deduplicato', () => {
    const singlePool = getItemImagePool(itemSingle);
    expect(singlePool).toEqual(['https://example.com/leo1.jpg']);

    const multiPool = getItemImagePool(itemMulti);
    expect(multiPool).toHaveLength(3);
    expect(multiPool).toContain('https://example.com/brad1.jpg');
    expect(multiPool).toContain('https://example.com/brad2.jpg');
    expect(multiPool).toContain('https://example.com/brad3.jpg');
  });

  it('esclude automaticamente le immagini presenti nella blacklist', () => {
    blacklistService.flagImage('https://example.com/brad2.jpg');
    const pool = getItemImagePool(itemMulti);
    expect(pool).toHaveLength(2);
    expect(pool).toContain('https://example.com/brad1.jpg');
    expect(pool).not.toContain('https://example.com/brad2.jpg');
    expect(pool).toContain('https://example.com/brad3.jpg');
  });

  it('seleziona una foto casuale appartenente al pool pulito', () => {
    blacklistService.flagImage('https://example.com/brad1.jpg');
    blacklistService.flagImage('https://example.com/brad2.jpg');

    const selected = getRandomItemImage(itemMulti);
    expect(selected).toBe('https://example.com/brad3.jpg');

    const singleSelected = getRandomItemImage(itemSingle);
    expect(singleSelected).toBe('https://example.com/leo1.jpg');
  });

  it('prepareArenaDeck randomizza le foto del mazzo preservando gli elementi ed escludendo foto vietate', () => {
    blacklistService.flagImage('https://example.com/brad1.jpg');

    const items: DuelItem[] = [
      itemSingle,
      itemMulti,
      {
        id: 'multi-2',
        answer: 'Gerry Scotti',
        aliases: ['scotti'],
        imageUrl: 'https://example.com/gerry1.jpg',
        imageUrls: [
          'https://example.com/gerry1.jpg',
          'https://example.com/gerry2.jpg',
          'https://example.com/gerry3.jpg',
        ],
      },
    ];

    const deck = prepareArenaDeck(items);
    expect(deck).toHaveLength(3);
    const answers = deck.map((d) => d.answer);
    expect(answers).toContain('Leonardo DiCaprio');
    expect(answers).toContain('Brad Pitt');
    expect(answers).toContain('Gerry Scotti');

    const bradItem = deck.find((d) => d.answer === 'Brad Pitt')!;
    // brad1 is blacklisted, so it must be brad2 or brad3
    expect(['https://example.com/brad2.jpg', 'https://example.com/brad3.jpg']).toContain(
      bradItem.imageUrl
    );
  });

  it('alterna le foto del pool ed evita di ripetere la stessa immagine consecutivamente', () => {
    const first = getRandomItemImage(itemMulti);
    const second = getRandomItemImage(itemMulti);
    expect(second).not.toBe(first);
  });

  it('prepareArenaDeck dà priorità ai soggetti mai visti rispetto a quelli marcati con markItemSeen', () => {
    const items: DuelItem[] = [
      { id: 'seen-1', answer: 'Già Visto 1', aliases: [], imageUrl: 'https://example.com/1.jpg' },
      { id: 'seen-2', answer: 'Già Visto 2', aliases: [], imageUrl: 'https://example.com/2.jpg' },
      { id: 'new-1', answer: 'Inedito 1', aliases: [], imageUrl: 'https://example.com/3.jpg' },
      { id: 'new-2', answer: 'Inedito 2', aliases: [], imageUrl: 'https://example.com/4.jpg' },
    ];

    markItemSeen('seen-1');
    markItemSeen('seen-2');

    const deck = prepareArenaDeck(items);
    const firstTwoIds = deck.slice(0, 2).map((d) => d.id);
    const lastTwoIds = deck.slice(2).map((d) => d.id);
    expect(firstTwoIds).toContain('new-1');
    expect(firstTwoIds).toContain('new-2');
    expect(lastTwoIds).toContain('seen-1');
    expect(lastTwoIds).toContain('seen-2');
  });

  it('quando l intera categoria è stata vista, inizia un nuovo ciclo tenendo gli ultimi visti in fondo', () => {
    const items: DuelItem[] = Array.from({ length: 12 }, (_, idx) => ({
      id: `item-${idx}`,
      answer: `Item ${idx}`,
      aliases: [],
      imageUrl: `https://example.com/${idx}.jpg`,
    }));

    items.forEach((it) => markItemSeen(it.id));

    const deck = prepareArenaDeck(items);
    expect(deck).toHaveLength(12);
    // Gli ultimi 4 visti (item-8..11) devono restare in coda nel nuovo ciclo
    const tailIds = deck.slice(-4).map((d) => d.id);
    expect(tailIds.sort()).toEqual(['item-10', 'item-11', 'item-8', 'item-9']);
  });
});
