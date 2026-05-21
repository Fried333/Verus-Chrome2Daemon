import React from 'react';

const S = ({ d, size = 20, color = 'currentColor' }: { d: string; size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{d.split('|').map((p, i) => <path key={i} d={p} />)}</svg>
);

export const IconSettings = ({ size }: { size?: number }) => <S size={size} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z|M15 12a3 3 0 11-6 0 3 3 0 016 0z" />;
export const IconSend = ({ size }: { size?: number }) => <S size={size} d="M22 2L11 13|M22 2l-7 20-4-9-9-4 20-7z" />;
export const IconReceive = ({ size }: { size?: number }) => <S size={size} d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4|M7 10l5 5 5-5|M12 15V3" />;
export const IconBack = ({ size }: { size?: number }) => <S size={size} d="M15 18l-6-6 6-6" />;
export const IconCopy = ({ size }: { size?: number }) => <S size={size} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2|M16 8h2a2 2 0 012 2v8a2 2 0 01-2 2h-8a2 2 0 01-2-2v-2" />;
export const IconCheck = ({ size }: { size?: number }) => <S size={size} d="M20 6L9 17l-5-5" />;
export const IconPlus = ({ size }: { size?: number }) => <S size={size} d="M12 5v14|M5 12h14" />;
export const IconUser = ({ size }: { size?: number }) => <S size={size} d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2|M12 3a4 4 0 100 8 4 4 0 000-8z" />;
export const IconLock = ({ size }: { size?: number }) => <S size={size} d="M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2z|M7 11V7a5 5 0 0110 0v4" />;
