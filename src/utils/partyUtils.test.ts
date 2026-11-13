import { describe, it, expect } from 'vitest';
import { PartyPlayer } from '../types/game';
import {
  getNextChallengerId,
  getDefaultOpponentId,
  getBalancedOpponentId,
  rankPartyPlayers,
} from './partyUtils';

describe('partyUtils', () => {
  const samplePlayers: PartyPlayer[] = [
    { id: 'p1', name: 'Mario', avatar: '🦊', wins: 2, duelsPlayed: 3 },
    { id: 'p2', name: 'Luigi', avatar: '🐯', wins: 3, duelsPlayed: 4 },
    { id: 'p3', name: 'Anna', avatar: '🐼', wins: 1, duelsPlayed: 2 },
    { id: 'p4', name: 'Paolo', avatar: '🐸', wins: 0, duelsPlayed: 1 },
  ];

  it('rotates to next challenger in cyclical order', () => {
    expect(getNextChallengerId(samplePlayers, 'p1')).toBe('p2');
    expect(getNextChallengerId(samplePlayers, 'p2')).toBe('p3');
    expect(getNextChallengerId(samplePlayers, 'p4')).toBe('p1');
  });

  it('selects first non-challenger as default opponent', () => {
    expect(getDefaultOpponentId(samplePlayers, 'p1')).toBe('p2');
    expect(getDefaultOpponentId(samplePlayers, 'p2')).toBe('p1');
  });

  it('balances opponent selection toward players with fewest duelsPlayed', () => {
    expect(getBalancedOpponentId(samplePlayers, 'p1')).toBe('p4');
    expect(getBalancedOpponentId(samplePlayers, 'p4')).toBe('p3');
  });

  it('ranks players by wins descending', () => {
    const ranked = rankPartyPlayers(samplePlayers);
    expect(ranked[0].id).toBe('p2'); // 3 wins
    expect(ranked[1].id).toBe('p1'); // 2 wins
    expect(ranked[2].id).toBe('p3'); // 1 win
    expect(ranked[3].id).toBe('p4'); // 0 wins
  });
});
