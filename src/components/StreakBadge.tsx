import React, { useEffect, useState } from 'react';

interface StreakBadgeProps {
  streak: number;
  className?: string;
}

export const StreakBadge: React.FC<StreakBadgeProps> = ({ streak, className = '' }) => {
  const [animClass, setAnimClass] = useState('animate-streak-pop');

  useEffect(() => {
    if (streak >= 5) {
      setAnimClass('animate-streak-pop-shake');
    } else if (streak >= 2) {
      setAnimClass('animate-streak-pop');
    }
  }, [streak]);

  if (streak < 2) return null;

  const isFire = streak >= 5;
  const isOrange = streak >= 3 && streak < 5;

  const bgClass = isFire
    ? 'bg-red text-white'
    : isOrange
    ? 'bg-[#FF8A00] text-ink'
    : 'bg-yellow text-ink';

  const sizeClass = isFire
    ? 'text-sm sm:text-base px-3.5 py-1.5'
    : isOrange
    ? 'text-xs sm:text-sm px-3 py-1'
    : 'text-xs px-2.5 py-0.5';

  const label = isFire
    ? `🔥 ON FIRE x${streak}`
    : `${streak} IN A ROW`;

  return (
    <div
      key={`streak-${streak}`}
      className={`absolute -top-3 -right-3 z-30 font-display font-black tracking-wide rounded-full border-[3px] border-ink shadow-hard-sm select-none pointer-events-none -rotate-3 ${bgClass} ${sizeClass} ${animClass} ${className}`}
    >
      {isFire && (
        <span
          aria-hidden="true"
          className="absolute inset-0 -z-10 rounded-full bg-yellow/65 animate-ping"
        />
      )}
      {label}
    </div>
  );
};
