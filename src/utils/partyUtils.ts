import { PartyPlayer } from '../types/game';

/**
 * Ruota lo sfidante al giocatore successivo nel torneo Party.
 */
export function getNextChallengerId(
  players: PartyPlayer[],
  currentChallengerId: string
): string {
  if (players.length === 0) return '';
  const currentIdx = players.findIndex((p) => p.id === currentChallengerId);
  const nextIdx = (currentIdx + 1) % players.length;
  return players[nextIdx].id;
}

/**
 * Seleziona un avversario predefinito diverso dallo sfidante.
 */
export function getDefaultOpponentId(
  players: PartyPlayer[],
  challengerId: string
): string {
  const eligible = players.filter((p) => p.id !== challengerId);
  return eligible.length > 0 ? eligible[0].id : '';
}

/**
 * Seleziona l'avversario più bilanciato (chi ha giocato meno duelli, mantenendo l'ordine a parità).
 */
export function getBalancedOpponentId(
  players: PartyPlayer[],
  challengerId: string
): string {
  const eligible = players.filter((p) => p.id !== challengerId);
  if (eligible.length === 0) return '';
  const sorted = [...eligible].sort((a, b) => a.duelsPlayed - b.duelsPlayed);
  return sorted[0].id;
}

/**
 * Ordina i giocatori del Party per vittorie (decrescente) e duelli giocati.
 */
export function rankPartyPlayers(players: PartyPlayer[]): PartyPlayer[] {
  return [...players].sort((a, b) => {
    if (b.wins !== a.wins) {
      return b.wins - a.wins;
    }
    return a.duelsPlayed - b.duelsPlayed;
  });
}
