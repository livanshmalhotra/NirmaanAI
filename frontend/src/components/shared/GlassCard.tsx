import React from 'react';

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function GlassCard({ children, className = '', style }: GlassCardProps) {
  return (
    <div 
      className={`glass-panel ${className}`} 
      style={{ padding: '1.5rem', ...style }}
    >
      {children}
    </div>
  );
}
