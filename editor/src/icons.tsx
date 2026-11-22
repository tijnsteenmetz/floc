import type { CSSProperties } from 'react';

export const PATHS = {
  select: 'M5 3l14 8-6 2-2 6z',
  line: 'M4 19c4-8 8 2 16-14',
  polygon: 'M5 7l7-4 7 5-2 10H7z',
  rect: 'M4 6h16v12H4z',
  hole: 'M4 4h16v16H4zM9 9h6v6H9z',
  pin: 'M12 21s-7-6-7-11a7 7 0 0114 0c0 5-7 11-7 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  route: 'M6 20.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM18 8.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM8.5 18H15a3 3 0 000-6H9a3 3 0 010-6h6.5',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  map: 'M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  shapes: 'M4 4h7v7H4zM17.5 4a3.5 3.5 0 110 7 3.5 3.5 0 010-7zM7.5 13L11 20H4zM14 14h7v7h-7z',
  upload: 'M12 3v12M7 8l5-5 5 5M5 21h14',
  download: 'M12 15V3M7 10l5 5 5-5M5 21h14',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 005.4-1.6',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M16 4v4M10 10v4M18 16v4',
  close: 'M6 6l12 12M18 6L6 18',
  back: 'M15 18l-6-6 6-6',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  stage: 'M3 20h18M5 20V10l7-5 7 5v10M9 20v-5h6v5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  check: 'M5 12l5 5L20 7',
  warn: 'M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 018 0v4',
  rotate: 'M20 12a8 8 0 11-2.3-5.7M20 4v5h-5',
  crosshair: 'M12 19a7 7 0 100-14 7 7 0 000 14zM12 2v5M12 17v5M2 12h5M17 12h5',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  file: 'M14 3H6v18h12V7zM14 3v4h4',
  crop: 'M6 2v14a2 2 0 002 2h14M2 6h14a2 2 0 012 2v14',
  bucket: 'M5 11l7-7 7 7-7 7zM5 11h14M20 15s1.5 2 1.5 3a1.5 1.5 0 01-3 0c0-1 1.5-3 1.5-3z',
  wand: 'M4 20L15 9M17 3v3M17 12v3M11 6h3M20 6h3M13.5 4.5l1.5 1.5M19 9l1.5 1.5M19 4.5L20.5 3',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  chevR: 'M9 6l6 6-6 6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, stroke = 1.9, style, color }: { name: IconName; size?: number; stroke?: number; style?: CSSProperties; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? 'currentColor'} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
      <path d={PATHS[name]} />
    </svg>
  );
}
