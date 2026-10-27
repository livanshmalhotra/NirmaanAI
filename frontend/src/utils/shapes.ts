/**
 * Building shapes offered on the setup screen. Mirror of SHAPES in
 * backend/services/geometry.py, used here only to draw previews — the
 * backend computes the real footprints.
 */
export interface ShapeDef {
  id: string;
  label: string;
  ratio: number;                                 // bbox width / depth
  rects: [number, number, number, number][];     // normalised x, z, w, d
  hint: string;
}

export const SHAPES: ShapeDef[] = [
  { id: 'rectangle', label: 'Rectangle', ratio: 4 / 3, rects: [[0, 0, 1, 1]], hint: 'Classic, most efficient' },
  { id: 'square',    label: 'Square',    ratio: 1,     rects: [[0, 0, 1, 1]], hint: 'Compact footprint' },
  { id: 'pyramid',   label: 'Pyramid',   ratio: 4 / 3, rects: [[0, 0, 1, 1]], hint: 'Each floor steps in' },
  { id: 'l-shape',   label: 'L-Shape',   ratio: 1.2,   rects: [[0, 0, 0.5, 1], [0.5, 0.5, 0.5, 0.5]], hint: 'Corner courtyard / garden' },
  { id: 'u-shape',   label: 'U-Shape',   ratio: 1.4,   rects: [[0, 0, 0.34, 1], [0.66, 0, 0.34, 1], [0.34, 0.55, 0.32, 0.45]], hint: 'Two wings, rear court' },
  { id: 't-shape',   label: 'T-Shape',   ratio: 1.3,   rects: [[0, 0, 1, 0.45], [0.3, 0.45, 0.4, 0.55]], hint: 'Wide back, entry stem' },
  { id: 'courtyard', label: 'Courtyard', ratio: 1.2,   rects: [[0, 0, 1, 0.3], [0, 0.7, 1, 0.3], [0, 0.3, 0.3, 0.4], [0.7, 0.3, 0.3, 0.4]], hint: 'Open-to-sky centre' },
];
