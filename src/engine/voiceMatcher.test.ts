import { describe, it, expect } from 'vitest';
import { evaluateVoiceInput, normalizeText, phoneticSkeleton } from './voiceMatcher';
import { DEFAULT_CATEGORIES } from '../data/categories';
import { APP_VERSION } from '../config/version';
import { DuelItem } from '../types/game';

describe('voiceMatcher Engine & Real-Photo Catalog', () => {
  const sampleItem: DuelItem = {
    id: 'test-1',
    answer: 'Ippopotamo',
    aliases: ['ipopotamo', 'ippopotami'],
    imageUrl: 'https://upload.wikimedia.org/sample.jpg',
  };

  it('normalizza articoli, apostrofi, accenti e numeri', () => {
    expect(normalizeText("L'Elefante è grande")).toBe('elefante grande');
    expect(normalizeText('Un caffè! Sette')).toBe('caffe sette');
    expect(normalizeText('PlayStation 5')).toBe('playstation cinque');
  });

  it('riconosce la risposta anche dentro una frase parlata continua', () => {
    const res = evaluateVoiceInput(['allora secondo me è un ippopotamo sicuro'], sampleItem);
    expect(res.matched).toBe(true);
    expect(res.isPassCommand).toBe(false);
  });

  it('accetta errori di doppie o trascrizione fonetica', () => {
    const res = evaluateVoiceInput(['ipopotami'], sampleItem);
    expect(res.matched).toBe(true);
  });

  it('accetta singolare e plurale automaticamente', () => {
    const forbiciItem: DuelItem = {
      id: 'forbici',
      answer: 'Forbici',
      aliases: ['paio di forbici', 'cesoie'],
      imageUrl: 'https://upload.wikimedia.org/sample.jpg',
    };
    expect(evaluateVoiceInput(['la forbice'], forbiciItem).matched).toBe(true);
    expect(evaluateVoiceInput(['le forbici'], forbiciItem).matched).toBe(true);
  });

  it('accetta varianti italo-inglesi senza spazi o con spazi (es. Spider-Man)', () => {
    const spiderItem: DuelItem = {
      id: 'spiderman',
      answer: 'Spider-Man',
      aliases: ['uomo ragno', 'spiderman', 'spaidermen', 'peter parker'],
      imageUrl: 'https://upload.wikimedia.org/sample.jpg',
    };
    expect(evaluateVoiceInput(['spider man'], spiderItem).matched).toBe(true);
    expect(evaluateVoiceInput(['l uomo ragno'], spiderItem).matched).toBe(true);
    expect(evaluateVoiceInput(['spaidermen'], spiderItem).matched).toBe(true);
  });

  it('rileva immediatamente il comando vocale PASSO ma NON fa falso positivo su Passaporto', () => {
    expect(evaluateVoiceInput(['non lo so passo'], sampleItem).isPassCommand).toBe(true);

    const passaportoItem: DuelItem = {
      id: 'passaporto',
      answer: 'Passaporto',
      aliases: ['documento'],
      imageUrl: 'https://upload.wikimedia.org/sample.jpg',
    };
    const res = evaluateVoiceInput(['il passaporto'], passaportoItem);
    expect(res.isPassCommand).toBe(false);
    expect(res.matched).toBe(true);
  });

  it('riconosce comandi PASSO e risposte sia in italiano che in inglese', () => {
    const animalItem: DuelItem = {
      id: 'leone',
      answer: 'Leone',
      aliases: ['re della savana'],
      answerEn: 'Lion',
      aliasesEn: ['lions', 'king of the jungle'],
      imageUrl: 'https://upload.wikimedia.org/sample.jpg',
    };

    // Risposta in italiano
    expect(evaluateVoiceInput(['è un leone'], animalItem).matched).toBe(true);
    // Risposta in inglese
    expect(evaluateVoiceInput(['it is a lion'], animalItem).matched).toBe(true);
    expect(evaluateVoiceInput(['the lions'], animalItem).matched).toBe(true);

    // Comandi vocali di passo in inglese
    expect(evaluateVoiceInput(['pass'], animalItem).isPassCommand).toBe(true);
    expect(evaluateVoiceInput(['skip'], animalItem).isPassCommand).toBe(true);
    expect(evaluateVoiceInput(['i do not know skip'], animalItem).isPassCommand).toBe(true);
  });

  it('genera correttamente lo scheletro fonetico', () => {
    expect(phoneticSkeleton('ippopotamo')).toBe('ipopotamo');
    expect(phoneticSkeleton('smartphone')).toBe('smartfone');
  });

  it('riconosce con precisione titoli di videogiochi con fonetica italo-inglese e sub-token', () => {
    const videogames: DuelItem[] = [
      {
        id: 'vg-hollow',
        answer: 'Hollow Knight',
        aliases: ['ollo nait', 'olo nait', 'hollow', 'knight'],
        imageUrl: 'https://sample.com/hk.jpg',
      },
      {
        id: 'vg-witcher',
        answer: 'The Witcher 3',
        aliases: ['uiccer', 'wicher', 'de wicher', 'the witcher', 'geralt'],
        imageUrl: 'https://sample.com/w3.jpg',
      },
      {
        id: 'vg-cyberpunk',
        answer: 'Cyberpunk 2077',
        aliases: ['saiber pank', 'saiberpank', 'cyberpunk'],
        imageUrl: 'https://sample.com/cp.jpg',
      },
      {
        id: 'vg-minecraft',
        answer: 'Minecraft',
        aliases: ['main craft', 'mine craft', 'maincraft'],
        imageUrl: 'https://sample.com/mc.jpg',
      },
      {
        id: 'vg-gta',
        answer: 'Grand Theft Auto V',
        aliases: ['grand theft auto', 'gran teft auto', 'gta', 'gta 5'],
        imageUrl: 'https://sample.com/gta.jpg',
      },
      {
        id: 'vg-elden',
        answer: 'Elden Ring',
        aliases: ['il the ring', 'elder ring', 'el den ring', 'elden'],
        imageUrl: 'https://sample.com/er.jpg',
      },
      {
        id: 'vg-godofwar',
        answer: 'God of War',
        aliases: ['god of vor', 'goddo vor', 'god of uor', 'kratos'],
        imageUrl: 'https://sample.com/gow.jpg',
      },
      {
        id: 'vg-rdr2',
        answer: 'Red Dead Redemption 2',
        aliases: ['red dead', 'red ded', 'red de ed', 'arthur morgan'],
        imageUrl: 'https://sample.com/rdr2.jpg',
      },
      {
        id: 'vg-dbd',
        answer: 'Dead by Daylight',
        aliases: ['dead by daylight', 'ded bai deilait', 'dbd'],
        imageUrl: 'https://sample.com/dbd.jpg',
      },
    ];

    // Trascrizioni fonetiche ASR reali per videogiochi
    expect(evaluateVoiceInput(['ollo nait'], videogames[0]).matched).toBe(true);
    expect(evaluateVoiceInput(['olo nait'], videogames[0]).matched).toBe(true);
    expect(evaluateVoiceInput(['uiccer'], videogames[1]).matched).toBe(true);
    expect(evaluateVoiceInput(['de wicher'], videogames[1]).matched).toBe(true);
    expect(evaluateVoiceInput(['witcher'], videogames[1]).matched).toBe(true);
    expect(evaluateVoiceInput(['saiber pank'], videogames[2]).matched).toBe(true);
    expect(evaluateVoiceInput(['cyberpunk'], videogames[2]).matched).toBe(true);
    expect(evaluateVoiceInput(['main craft'], videogames[3]).matched).toBe(true);
    expect(evaluateVoiceInput(['mine craft'], videogames[3]).matched).toBe(true);
    expect(evaluateVoiceInput(['gran teft auto'], videogames[4]).matched).toBe(true);
    expect(evaluateVoiceInput(['gta'], videogames[4]).matched).toBe(true);
    expect(evaluateVoiceInput(['il the ring'], videogames[5]).matched).toBe(true);
    expect(evaluateVoiceInput(['elder ring'], videogames[5]).matched).toBe(true);
    expect(evaluateVoiceInput(['elden'], videogames[5]).matched).toBe(true);
    expect(evaluateVoiceInput(['goddo vor'], videogames[6]).matched).toBe(true);
    expect(evaluateVoiceInput(['god of uor'], videogames[6]).matched).toBe(true);
    expect(evaluateVoiceInput(['kratos'], videogames[6]).matched).toBe(true);
    expect(evaluateVoiceInput(['red ded'], videogames[7]).matched).toBe(true);
    expect(evaluateVoiceInput(['red dead'], videogames[7]).matched).toBe(true);
    expect(evaluateVoiceInput(['ded bai deilait'], videogames[8]).matched).toBe(true);
  });

  it('riconosce celebrità e attori pronunciati all italiana o gridando solo il nome/cognome', () => {
    const keanu: DuelItem = {
      id: 'keanu',
      answer: 'Keanu Reeves',
      aliases: ['chianu rivs', 'kianu', 'keanu', 'reeves', 'john wick', 'neo'],
      imageUrl: 'https://sample.com/keanu.jpg',
    };
    expect(evaluateVoiceInput(['chianu rivs'], keanu).matched).toBe(true);
    expect(evaluateVoiceInput(['keanu'], keanu).matched).toBe(true);
    expect(evaluateVoiceInput(['reeves'], keanu).matched).toBe(true);

    const dwayne: DuelItem = {
      id: 'dwayne',
      answer: 'Dwayne Johnson',
      aliases: ['duein gionson', 'duein', 'johnson', 'the rock', 'la roccia'],
      imageUrl: 'https://sample.com/rock.jpg',
    };
    expect(evaluateVoiceInput(['duein gionson'], dwayne).matched).toBe(true);
    expect(evaluateVoiceInput(['the rock'], dwayne).matched).toBe(true);
    expect(evaluateVoiceInput(['johnson'], dwayne).matched).toBe(true);

    const scarlett: DuelItem = {
      id: 'scarlett',
      answer: 'Scarlett Johansson',
      aliases: ['scarlet gioanson', 'gioanson', 'johansson', 'scarlett'],
      imageUrl: 'https://sample.com/scarlett.jpg',
    };
    expect(evaluateVoiceInput(['scarlet gioanson'], scarlett).matched).toBe(true);
    expect(evaluateVoiceInput(['gioanson'], scarlett).matched).toBe(true);
    expect(evaluateVoiceInput(['scarlett'], scarlett).matched).toBe(true);

    const cillian: DuelItem = {
      id: 'cillian',
      answer: 'Cillian Murphy',
      aliases: ['killian marfi', 'cillian', 'murphy', 'oppenheimer'],
      imageUrl: 'https://sample.com/cillian.jpg',
    };
    expect(evaluateVoiceInput(['killian marfi'], cillian).matched).toBe(true);
    expect(evaluateVoiceInput(['cillian'], cillian).matched).toBe(true);
    expect(evaluateVoiceInput(['murphy'], cillian).matched).toBe(true);

    const leo: DuelItem = {
      id: 'leo',
      answer: 'Leonardo DiCaprio',
      aliases: ['leonardo', 'dicaprio', 'di caprio'],
      imageUrl: 'https://sample.com/leo.jpg',
    };
    expect(evaluateVoiceInput(['dicaprio'], leo).matched).toBe(true);
    expect(evaluateVoiceInput(['leonardo'], leo).matched).toBe(true);
  });

  it('rispetta la separazione di responsabilità: nessun dato di dominio cablato in voiceMatcher.ts', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const code = fs.readFileSync(path.resolve('src/engine/voiceMatcher.ts'), 'utf8');

    // Il codice TypeScript del motore deve essere 100% data-agnostic
    const forbiddenDomainTerms = [
      'keanu',
      'witcher',
      'minecraft',
      'elden',
      'cyberpunk',
      'dicaprio',
      'kratos',
      'stranger',
    ];
    for (const term of forbiddenDomainTerms) {
      expect(code.toLowerCase()).not.toContain(term);
    }
  });

  it('contiene 56 categorie modulari con oltre 2100 fotografie HD validate e zero emoji-svg nei duelli', () => {
    expect(DEFAULT_CATEGORIES.length).toBe(56);
    let totalPhotos = 0;
    for (const cat of DEFAULT_CATEGORIES) {
      expect(cat.items.length).toBeGreaterThanOrEqual(30);
      for (const item of cat.items) {
        expect(item.imageUrl).toMatch(/^https:\/\//);
        expect(item.imageUrl).not.toContain('twemoji');
        totalPhotos++;
      }
    }
    expect(totalPhotos).toBeGreaterThan(2100);
  });

  it('include pool multi-foto (anti-memorizzazione) per oltre 400 personaggi celebri', () => {
    let multiPhotoSubjects = 0;
    let totalPhotosInPools = 0;
    for (const cat of DEFAULT_CATEGORIES) {
      for (const item of cat.items) {
        if (Array.isArray(item.imageUrls) && item.imageUrls.length > 1) {
          multiPhotoSubjects++;
          totalPhotosInPools += item.imageUrls.length;
          item.imageUrls.forEach((url) => {
            expect(url).toMatch(/^https:\/\//);
            expect(url).not.toContain('?');
          });
        }
      }
    }
    expect(multiPhotoSubjects).toBeGreaterThan(400);
    expect(totalPhotosInPools).toBeGreaterThan(1500);
  });

  it('ha un formato di versione semver valido (es. 1.0.0, 1.0.1)', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('previene i falsi positivi su parole corte, token generici e parole parziali di titoli composti', () => {
    const item = (answer: string, aliases: string[] = []) => ({
      id: 'test-fp',
      answer,
      aliases,
      imageUrl: 'https://example.com/x.jpg',
    });

    // Parole simili ma errate su parole brevi (4-5 lettere)
    expect(evaluateVoiceInput(['fatto'], item('Gatto', ['micio'])).matched).toBe(false);
    expect(evaluateVoiceInput(['male'], item('Mela')).matched).toBe(false);
    expect(evaluateVoiceInput(['fino'], item('Vino', ['vino rosso'])).matched).toBe(false);
    expect(evaluateVoiceInput(['palo'], item('Palla')).matched).toBe(false);

    // Token generici o singole parole di titoli composti NON devono bastare da soli
    expect(
      evaluateVoiceInput(
        ['maschera'],
        item('Maschera Veneziana', ['bauta', 'maschera di carnevale'])
      ).matched
    ).toBe(false);
    expect(
      evaluateVoiceInput(['ponte'], item('Ponte di Rialto', ['rialto'])).matched
    ).toBe(false);
    expect(
      evaluateVoiceInput(['marco'], item('Marco Materazzi', ['materazzi'])).matched
    ).toBe(false);

    // Il match completo o l'alias specifico continuano a funzionare
    expect(
      evaluateVoiceInput(['materazzi'], item('Marco Materazzi', ['materazzi'])).matched
    ).toBe(true);
    expect(evaluateVoiceInput(['gatto'], item('Gatto', ['micio'])).matched).toBe(true);
  });

  it('rispetta la gerarchia delle alternative senza far prevalere pass rumorosi in coda e distingue interim da final', () => {
    const gatto = {
      id: 'test-gatto',
      answer: 'Gatto',
      aliases: [],
      imageUrl: 'https://example.com/gatto.jpg',
    };
    const materazzi = {
      id: 'test-materazzi',
      answer: 'Marco Materazzi',
      aliases: ['materazzi'],
      imageUrl: 'https://example.com/m.jpg',
    };

    // Un "passa" rumoroso all'ultima alternativa non può battere una risposta valida in alt[0]
    const validFirst = evaluateVoiceInput(
      ['Gatto', 'tatto', 'fatto', 'passa'],
      gatto,
      { isFinal: true }
    );
    expect(validFirst.matched).toBe(true);
    expect(validFirst.isPassCommand).toBe(false);

    // Un comando "passo" pulito in prima alternativa resta PASS
    const cleanPass = evaluateVoiceInput(['passo', 'basso'], gatto, { isFinal: true });
    expect(cleanPass.isPassCommand).toBe(true);

    // In modalità interim (parlato in corso), un match esatto passa cleanly
    const exactInterim = evaluateVoiceInput(['Marco Materazzi'], materazzi, { isFinal: false });
    expect(exactInterim.matched).toBe(true);
  });
});
