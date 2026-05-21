import React from 'react';

export type NavTab = 'wallet' | 'swap' | 'ids';

interface Props {
  active: NavTab;
  onChange: (tab: NavTab) => void;
}

export function BottomNav({ active, onChange }: Props) {
  const tabs: Array<{ id: NavTab; label: string; icon: string }> = [
    { id: 'wallet', label: 'Wallet', icon: 'M21 18v1a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1h16a1 1 0 011 1v1|M3 10h18|M17 14a1 1 0 100 2 1 1 0 000-2z' },
    { id: 'swap', label: 'Swap', icon: 'M7 16V4m0 0L3 8m4-4l4 4|M17 8v12m0 0l4-4m-4 4l-4-4' },
    { id: 'ids', label: 'IDs', icon: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2|M12 3a4 4 0 100 8 4 4 0 000-8z' },
  ];

  return (
    <div style={{
      display: 'flex', borderTop: '1px solid var(--border)', flexShrink: 0,
      background: 'var(--bg-primary)',
    }}>
      {tabs.map(tab => (
        <button key={tab.id} onClick={() => onChange(tab.id)} style={{
          flex: 1, padding: '10px 0 8px', display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: 3, border: 'none', background: 'none', cursor: 'pointer',
          color: active === tab.id ? 'var(--accent)' : 'var(--text-subtle)',
          fontSize: 10, fontWeight: 500,
        }}>
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            {tab.icon.split('|').map((d, i) => <path key={i} d={d} />)}
          </svg>
          {tab.label}
        </button>
      ))}
    </div>
  );
}
