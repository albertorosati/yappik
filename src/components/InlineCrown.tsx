import React from 'react';

interface InlineCrownProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  animate?: boolean;
}

export const InlineCrown: React.FC<InlineCrownProps> = ({
  className = '',
  size = 'md',
  animate = true,
}) => {
  const sizeClasses = {
    sm: 'w-6 h-5',
    md: 'w-8 h-7',
    lg: 'w-10 h-8',
  }[size];

  return (
    <div
      className={`inline-block select-none pointer-events-none ${
        animate ? 'animate-crown-land' : ''
      } ${className}`}
      style={{ filter: 'drop-shadow(2px 2px 0 #14121F)' }}
      aria-hidden="true"
    >
      <div className={animate ? 'animate-float-gentle' : ''}>
        <svg
          viewBox="0 0 36 28"
          className={`${sizeClasses} overflow-visible`}
          fill="#FFC933"
          stroke="#14121F"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon points="4,24 32,24 32,9 24,18 18,4 12,18 4,9" />
          <circle cx="18" cy="4" r="2" fill="#FF3D6E" stroke="#14121F" strokeWidth="1.5" />
          <circle cx="4" cy="9" r="1.8" fill="#2F6BFF" stroke="#14121F" strokeWidth="1.5" />
          <circle cx="32" cy="9" r="1.8" fill="#2F6BFF" stroke="#14121F" strokeWidth="1.5" />
        </svg>
      </div>
    </div>
  );
};
