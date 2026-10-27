export const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

export const BUDGET = {
  INITIAL: 5_000_000,
  COST_PER_FLOOR: 500_000,
  COST_PER_ROOM: 100_000,
} as const;

export const CONSTRAINTS = {
  MAX_FLOORS: 10,
  MAX_ROOMS_PER_FLOOR: 12,
  MIN_ROOMS_PER_FLOOR: 1,
} as const;

export const FLOOR_COLORS: Record<number, string> = {
  1:  'var(--floor-1)',
  2:  'var(--floor-2)',
  3:  'var(--floor-3)',
  4:  'var(--floor-4)',
  5:  'var(--floor-5)',
  6:  'var(--floor-6)',
  7:  'var(--floor-7)',
  8:  'var(--floor-8)',
  9:  'var(--floor-9)',
  10: 'var(--floor-10)',
};

export const WELCOME_MESSAGE =
  "Welcome! I'm your AI Architect Assistant. You have a ₹50L budget to build with.\n\n" +
  "Try commands like:\n" +
  "• \"Add a floor\"\n" +
  "• \"Add a 160 sqft bedroom to floor 1\"\n" +
  "• Open **Floor Plan** to size each room and click exactly where it goes\n" +
  "• \"Suggest improvements\"\n" +
  "• \"Show status\"";

export const QUICK_ACTIONS = [
  'Use my current location',
  'Add a floor',
  'Add a 160 sqft bedroom to floor 1',
  'Suggest improvements',
  'Show status',
  'Reset building',
];
