import React from 'react';

interface SplitLayoutProps {
  chatPanel: React.ReactNode;
  visualizerPanel: React.ReactNode;
}

export function SplitLayout({ chatPanel, visualizerPanel }: SplitLayoutProps) {
  return (
    <div style={{
      display: 'flex',
      flex: 1,
      overflow: 'hidden', // Contain scrolling within panels
      width: '100%',
      height: '100%'
    }}>
      {/* Chat Panel - Fixed width */}
      <div style={{
        width: '35%',
        minWidth: '350px',
        maxWidth: '500px',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--bg-secondary)',
      }}>
        {chatPanel}
      </div>

      {/* Visualizer Panel - Flexible width */}
      <div style={{
        flex: 1,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--bg-primary)',
        overflow: 'hidden'
      }}>
        {visualizerPanel}
      </div>
    </div>
  );
}
