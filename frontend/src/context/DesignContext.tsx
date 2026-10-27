import { createContext, useContext, useState, type ReactNode } from 'react';
import { useBuilding } from './BuildingContext';
import type { Preset } from '../utils/presets';

/** A room waiting for the user to click its spot in the 3D view. */
export type Placement =
  | { kind: 'new'; floor: number; type: string; name: string; w: number; d: number }
  | { kind: 'existing'; floor: number; roomId: string; type: string; name: string; w: number; d: number };

export interface Notice { text: string; error: boolean }

/** UI state shared by the left-hand design panel and the 3D view. */
interface DesignState {
  placing: Placement | null;
  setPlacing: (p: Placement | null | ((p: Placement | null) => Placement | null)) => void;
  /** Floor being worked on; floors above it are cut away in 3D. null = whole building. */
  focusFloor: number | null;
  setFocusFloor: (n: number | null) => void;
  notice: Notice | null;
  setNotice: (n: Notice | null) => void;
  /** Bumped whenever wall thickness changes, so the 3D view can highlight the walls. */
  wallsPulse: number;
  pulseWalls: () => void;
  /** Preset (1BHK, 2BHK …) the user is about to add — shows the "which floor / what sizes" dialog. */
  preset: Preset | null;
  openPreset: (p: Preset | null) => void;
}

const DesignContext = createContext<DesignState | undefined>(undefined);

export function DesignProvider({ children }: { children: ReactNode }) {
  const [placing, setPlacing] = useState<Placement | null>(null);
  const [focusFloor, setFocusFloor] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [wallsPulse, setWallsPulse] = useState(0);
  const [preset, openPreset] = useState<Preset | null>(null);

  // Whenever a floor is added (toolbar, chat, preset…) jump to it
  const { state } = useBuilding();
  const floorCount = state.floors.length;
  const [prevCount, setPrevCount] = useState(floorCount);
  if (floorCount !== prevCount) {
    setPrevCount(floorCount);
    if (floorCount > prevCount) setFocusFloor(Math.max(...state.floors.map(f => f.number)));
  }

  return (
    <DesignContext.Provider value={{
      placing, setPlacing, focusFloor, setFocusFloor, notice, setNotice,
      wallsPulse, pulseWalls: () => setWallsPulse(n => n + 1),
      preset, openPreset,
    }}>
      {children}
    </DesignContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useDesign() {
  const ctx = useContext(DesignContext);
  if (!ctx) throw new Error('useDesign must be used within a DesignProvider');
  return ctx;
}
