import React from 'react';

export interface TheFloorLogoProps {
  size?: 'hero' | 'header' | 'mobile';
  className?: string;
}

export interface LetterTile {
  char: string;
  bgHex: string;
  textColor: string;
  tiltDeg: number;
}

const LETTERS: LetterTile[] = [
  { char: 'Y', bgHex: '#FFC933', textColor: '#14121F', tiltDeg: -2 },
  { char: 'A', bgHex: '#2F6BFF', textColor: '#FFFFFF', tiltDeg: 1.5 },
  { char: 'P', bgHex: '#FF3D6E', textColor: '#FFFFFF', tiltDeg: -1 },
  { char: 'P', bgHex: '#19C37D', textColor: '#14121F', tiltDeg: 2 },
  { char: 'I', bgHex: '#FFFDF5', textColor: '#14121F', tiltDeg: -1.5 },
  { char: 'K', bgHex: '#FFC933', textColor: '#14121F', tiltDeg: 1.5 },
];

export const YappikLogo: React.FC<TheFloorLogoProps> = ({
  size = 'hero',
  className = '',
}) => {
  const sizeClasses = {
    hero: 'w-11 h-11 sm:w-14 sm:h-14 lg:w-[60px] lg:h-[60px] xl:w-[66px] xl:h-[66px] text-2xl sm:text-3xl lg:text-4xl rounded-2xl border-[3px] border-ink shadow-hard select-none',
    header: 'w-8 h-8 sm:w-9 sm:h-9 text-base sm:text-lg rounded-xl border-[2.5px] border-ink shadow-hard-sm select-none',
    mobile: 'w-7 h-7 text-sm rounded-lg border-[2px] border-ink shadow-hard-sm select-none',
  }[size];

  const gapClass = {
    hero: 'gap-1.5 sm:gap-2.5 lg:gap-3',
    header: 'gap-1 sm:gap-1.5',
    mobile: 'gap-1',
  }[size];

  return (
    <div
      aria-label="YAPPIK"
      className={`flex items-center justify-center ${gapClass} ${className}`}
    >
      {LETTERS.map((item, idx) => (
        <div
          key={`yappik-${idx}-${item.char}`}
          style={{
            backgroundColor: item.bgHex,
            color: item.textColor,
            ['--tile-tilt' as string]: `${item.tiltDeg}deg`,
            animationDelay:
              size === 'hero'
                ? `${idx * 65}ms, ${520 + idx * 240}ms`
                : `${idx * 45}ms`,
          }}
          className={`relative overflow-hidden flex items-center justify-center font-display font-black leading-none transition-transform duration-200 hover:-translate-y-2 hover:scale-110 hover:rotate-0 cursor-default ${
            size === 'hero' ? 'animate-logo-tile-hero' : 'animate-logo-tile'
          } ${sizeClasses}`}
        >
          <span
            aria-hidden="true"
            className="absolute inset-x-1 top-1 h-1.5 rounded-full bg-white/35 pointer-events-none"
          />
          <span className="relative z-10">{item.char}</span>
        </div>
      ))}
    </div>
  );
};

export const TheFloorLogo = YappikLogo;
