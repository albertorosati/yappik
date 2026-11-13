import React, { useState, useMemo, useEffect, useRef } from 'react';
import { X, Search, Dices, Eye } from 'lucide-react';
import { Category, AppLanguage } from '../types/game';
import { getCategoryTitle, t } from '../services/i18n';
import { TheFloorBackground } from './TheFloorBackground';

interface CategoryGalleryModalProps {
  isOpen: boolean;
  categories: Category[];
  language?: AppLanguage;
  mode?: 'browse' | 'pick';
  onSelectCategory?: (category: Category) => void;
  onClose: () => void;
}

export const CATEGORY_THEMES: Record<string, string> = {
  // Movies & TV
  'attori-hollywood': 'movies',
  'cinema-cult': 'movies',
  'serie-tv': 'movies',
  'tv-italiana': 'movies',
  'registi-cinema': 'movies',
  'personaggi-disney': 'movies',
  'attori-italiani': 'movies',

  // Music
  'artisti-pop': 'music',
  'musica-italiana': 'music',
  'icone-musica-70-80-90': 'music',
  'strumenti-musicali': 'music',

  // Sports
  calciatori: 'sports',
  'leggende-sport': 'sports',
  'discipline-sportive': 'sports',
  'sport-invernali-estremi': 'sports',

  // Games
  videogiochi: 'games',
  pokemon: 'games',
  'giochi-tavolo': 'games',

  // Internet
  'youtuber-streamer': 'internet',
  'meme-tiktok': 'internet',
  'gen-z': 'internet',

  // Animals & Nature
  'razze-cani': 'animals',
  'animali-selvatici': 'animals',
  'razze-gatti': 'animals',
  'insetti-artropodi': 'animals',
  'uccelli-mondo': 'animals',
  'rettili-abissi': 'animals',
  'fiori-piante': 'animals',
  'spazio-natura': 'animals',
  'meraviglie-natura': 'animals',

  // Brands
  'snack-bibite': 'brands',
  'auto-moto': 'brands',
  'moda-accessori': 'brands',
  'cocktail-bevande': 'brands',
  'dolci-pasticceria': 'brands',
  'formaggi-salumi': 'brands',
  'cucina-italiana': 'brands',
  'cucina-mondo': 'brands',
};

const THEME_LABELS: Record<string, { it: string; en: string }> = {
  all: { it: 'Tutte', en: 'All' },
  movies: { it: 'Cinema & TV', en: 'Movies & TV' },
  music: { it: 'Musica', en: 'Music' },
  sports: { it: 'Sport', en: 'Sports' },
  games: { it: 'Videogiochi & Giochi', en: 'Games' },
  internet: { it: 'Internet & Trend', en: 'Internet' },
  animals: { it: 'Animali & Natura', en: 'Animals & Nature' },
  brands: { it: 'Food, Brand & Lifestyle', en: 'Brands & Food' },
  more: { it: 'Altro & Curiosità', en: 'More' },
};

const THEME_ORDER = [
  'all',
  'movies',
  'music',
  'sports',
  'games',
  'internet',
  'animals',
  'brands',
  'more',
];

export const CategoryGalleryModal: React.FC<CategoryGalleryModalProps> = ({
  isOpen,
  categories,
  language = 'it',
  mode = 'browse',
  onSelectCategory,
  onClose,
}) => {
  const [search, setSearch] = useState('');
  const [selectedTheme, setSelectedTheme] = useState('all');
  const [peekedCatId, setPeekedCatId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Esc closes
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  // Compute theme map
  const filteredCategories = useMemo(() => {
    const q = search.trim().toLowerCase();
    return categories.filter((cat) => {
      const title = getCategoryTitle(cat, language).toLowerCase();
      const themeKey = CATEGORY_THEMES[cat.id] || 'more';

      if (selectedTheme !== 'all' && themeKey !== selectedTheme) {
        return false;
      }

      if (!q) return true;
      return title.includes(q) || cat.name.toLowerCase().includes(q);
    });
  }, [categories, language, search, selectedTheme]);

  // Group by theme
  const groupedCategories = useMemo(() => {
    const groups: Record<string, Category[]> = {};
    THEME_ORDER.forEach((theme) => {
      if (theme !== 'all') groups[theme] = [];
    });

    filteredCategories.forEach((cat) => {
      const themeKey = CATEGORY_THEMES[cat.id] || 'more';
      if (!groups[themeKey]) groups[themeKey] = [];
      groups[themeKey].push(cat);
    });

    return groups;
  }, [filteredCategories]);

  if (!isOpen) return null;

  const handleSurpriseMe = () => {
    if (filteredCategories.length === 0) return;
    const randomCat =
      filteredCategories[Math.floor(Math.random() * filteredCategories.length)];
    if (mode === 'pick' && onSelectCategory) {
      onSelectCategory(randomCat);
      onClose();
    } else {
      setPeekedCatId(randomCat.id);
      // Scroll to that category card
      const el = document.getElementById(`cat-card-${randomCat.id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };

  const handleTileClick = (cat: Category) => {
    if (mode === 'pick' && onSelectCategory) {
      onSelectCategory(cat);
      onClose();
    } else {
      // Toggle peek
      setPeekedCatId((prev) => (prev === cat.id ? null : cat.id));
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 overflow-hidden flex flex-col select-none bg-[#0F0E1A]"
    >
      {/* Dark Stage Checkerboard Background */}
      <TheFloorBackground stage="modal" />

      {/* Main Container */}
      <div
        ref={containerRef}
        className="relative z-10 w-full max-w-[1100px] mx-auto h-[100dvh] flex flex-col p-4 sm:p-6 pb-[max(1rem,env(safe-area-inset-bottom))] overflow-hidden modal-slap-in"
      >
        {/* Top Header Card */}
        <div className="card-paper p-4 sm:p-5 mb-4 shrink-0 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="font-display font-black text-2xl sm:text-[28px] text-ink leading-tight">
                {language === 'en' ? 'Categories' : 'Categorie'}{' '}
                <span className="text-blue">({categories.length})</span>
              </h2>
              {mode === 'pick' && (
                <span className="px-3 py-1 rounded-full bg-yellow border-[3px] border-ink font-display font-black text-xs text-ink uppercase">
                  {language === 'en' ? 'Pick One' : 'Scegline una'}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSurpriseMe}
                className="btn-push px-3.5 py-2 rounded-xl bg-yellow border-[3px] border-ink text-ink font-display font-black text-sm flex items-center gap-1.5 shadow-hard-sm"
              >
                <Dices className="w-4 h-4" />
                <span>{language === 'en' ? 'Surprise me' : 'Sorprendimi'}</span>
              </button>

              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="btn-push w-10 h-10 rounded-xl bg-paper border-[3px] border-ink text-ink flex items-center justify-center shadow-hard-sm"
              >
                <X className="w-6 h-6 stroke-[3]" />
              </button>
            </div>
          </div>

          {/* Search bar + Theme chips */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            {/* Search Input */}
            <div className="relative flex-1">
              <Search className="w-5 h-5 absolute left-3.5 top-1/2 -translate-y-1/2 text-ink/60" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={
                  language === 'en'
                    ? 'Search categories...'
                    : 'Cerca tra le categorie...'
                }
                className="w-full pl-11 pr-4 py-2.5 rounded-xl bg-white border-[3px] border-ink text-ink font-sans font-bold text-sm focus:outline-none focus:ring-2 focus:ring-yellow"
              />
            </div>
          </div>

          {/* Theme Chips */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
            {THEME_ORDER.map((themeKey) => {
              const label =
                THEME_LABELS[themeKey]?.[language] ||
                THEME_LABELS[themeKey]?.it;
              const isSelected = selectedTheme === themeKey;
              return (
                <button
                  key={themeKey}
                  type="button"
                  onClick={() => setSelectedTheme(themeKey)}
                  className={`px-3.5 py-1.5 rounded-full font-display font-bold text-xs whitespace-nowrap border-[2.5px] border-ink transition-all ${
                    isSelected
                      ? 'bg-yellow text-ink shadow-hard-sm font-black'
                      : 'bg-white text-ink/80 hover:bg-paper'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Scrollable Category Grid Grouped by Theme */}
        <div className="flex-1 overflow-y-auto pr-1 space-y-6">
          {THEME_ORDER.filter((t) => t !== 'all').map((themeKey) => {
            const list = groupedCategories[themeKey];
            if (!list || list.length === 0) return null;
            const themeHeading =
              THEME_LABELS[themeKey]?.[language] || THEME_LABELS[themeKey]?.it;

            return (
              <div key={themeKey} className="flex flex-col gap-3">
                {/* Theme Section Header */}
                <div className="flex items-center gap-2">
                  <span className="font-display font-black text-lg text-paper uppercase tracking-wider bg-ink px-3 py-1 rounded-lg border-2 border-paper/40">
                    {themeHeading}
                  </span>
                  <span className="text-xs font-bold text-paper/70 font-sans">
                    ({list.length})
                  </span>
                </div>

                {/* 2 to 4 column responsive grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {list.map((cat, idx) => {
                    const title = getCategoryTitle(cat, language);
                    const tiltDeg = idx % 2 === 0 ? -1.5 : 1.5;
                    const isPeeked = peekedCatId === cat.id;
                    const samplePhotos = cat.items.slice(0, 3);

                    return (
                      <div
                        key={cat.id}
                        id={`cat-card-${cat.id}`}
                        className="relative group"
                      >
                        {/* Peek Card Fan Overlay (Active when tapped/hovered) */}
                        {isPeeked && (
                          <div className="absolute -top-24 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
                            <div className="flex items-center justify-center animate-pop-in">
                              {samplePhotos.map((item, pIdx) => {
                                const fanTilt =
                                  pIdx === 0 ? -8 : pIdx === 1 ? 0 : 8;
                                const fanY = pIdx === 1 ? -4 : 0;
                                const rawUrl =
                                  (item.imageUrls && item.imageUrls[0]) ||
                                  item.imageUrl;
                                return (
                                  <div
                                    key={item.id}
                                    style={{
                                      transform: `rotate(${fanTilt}deg) translateY(${fanY}px)`,
                                      marginLeft: pIdx === 0 ? 0 : '-20px',
                                    }}
                                    className="w-16 h-20 rounded-xl bg-paper border-[3px] border-ink shadow-hard overflow-hidden shrink-0 flex items-center justify-center"
                                  >
                                    <img
                                      src={rawUrl}
                                      alt={item.answer}
                                      loading="lazy"
                                      referrerPolicy="no-referrer"
                                      onError={(e) => {
                                        const img = e.currentTarget;
                                        if (!img.dataset.fallbackTried) {
                                          img.dataset.fallbackTried = '1';
                                          img.src = `https://wsrv.nl/?url=${encodeURIComponent(
                                            rawUrl
                                          )}&w=320&fit=inside&n=-1`;
                                        }
                                      }}
                                      className="w-full h-full object-cover"
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Category Sticker Tile */}
                        <button
                          type="button"
                          onClick={() => handleTileClick(cat)}
                          onMouseEnter={() => setPeekedCatId(cat.id)}
                          onMouseLeave={() =>
                            setPeekedCatId((prev) =>
                              prev === cat.id ? null : prev
                            )
                          }
                          style={{
                            backgroundColor: cat.themeHex || '#FFC933',
                            transform: isPeeked
                              ? 'translateY(-6px) scale(1.02)'
                              : `rotate(${tiltDeg}deg)`,
                          }}
                          className={`btn-push w-full min-h-[160px] p-4 rounded-card border-[3px] border-ink flex flex-col justify-between text-left transition-all relative overflow-hidden ${
                            isPeeked
                              ? 'shadow-hard-lifted z-20'
                              : 'shadow-hard'
                          }`}
                        >
                          {/* Big Emoji (72px) */}
                          <div className="flex items-center justify-between w-full">
                            <span className="text-5xl sm:text-6xl select-none leading-none">
                              {cat.icon}
                            </span>
                            <span className="px-2.5 py-1 rounded-full bg-paper border-[2.5px] border-ink text-ink font-display font-black text-xs shadow-hard-sm">
                              {cat.items.length} {language === 'en' ? 'photos' : 'foto'}
                            </span>
                          </div>

                          {/* Full Title (2 lines max, never ellipsis) */}
                          <div className="mt-2">
                            <h3 className="font-display font-black text-xl text-ink leading-tight line-clamp-2">
                              {title}
                            </h3>
                          </div>

                          {/* Action Hint */}
                          <div className="mt-2 flex items-center justify-between text-xs font-display font-bold text-ink/80 pt-1 border-t-2 border-ink/20">
                            <span>
                              {mode === 'pick'
                                ? language === 'en'
                                  ? 'Tap to select'
                                  : 'Tocca per scegliere'
                                : language === 'en'
                                ? 'Tap to peek'
                                : 'Tocca per sbirciare'}
                            </span>
                            <Eye className="w-3.5 h-3.5" />
                          </div>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom Done Button */}
        <div className="pt-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="btn-push w-full py-3.5 rounded-xl bg-yellow text-ink font-display font-black text-base border-[3px] border-ink shadow-hard uppercase tracking-wide"
          >
            {language === 'en' ? 'Done' : 'Fatto'}
          </button>
        </div>
      </div>
    </div>
  );
};
