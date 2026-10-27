import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDraft, compareLifecycle, discardDraft, fetchBuildingState, fetchLifecycle, generateDesign, getApiWorkspace,
  onServerState, placeRoom, setApiWorkspace, type LifecycleOptions,
} from './api';

const OPTIONS: LifecycleOptions = {
  horizon_years: 30, discount_pct: 0, structure: 'rcc_framed', wall_material: 'burnt_clay_brick',
  exterior_wall_in: null, plaster_mm: 15, roof_insulation: false, exterior_finish: 'exterior_emulsion',
  glass_u: null, glass_shgc: null, occupants: null, town: null, roof_type: 'concrete',
};

function ok(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

let fetchMock: ReturnType<typeof vi.fn>;
const headerOf = (call: number) => (fetchMock.mock.calls[call][1]?.headers as Record<string, string>)['X-Workspace'];

beforeEach(() => {
  fetchMock = vi.fn(() => ok({ floors: [] }));
  vi.stubGlobal('fetch', fetchMock);
  setApiWorkspace('main');
});

afterEach(() => {
  vi.unstubAllGlobals();
  setApiWorkspace('main');
});

describe('workspace routing', () => {
  it('sends requests to the user\'s building by default', async () => {
    await fetchBuildingState();
    expect(getApiWorkspace()).toBe('main');
    expect(headerOf(0)).toBe('main');
  });

  it('sends editor requests to the draft while it is open', async () => {
    setApiWorkspace('draft');
    await placeRoom(1, 'bedroom', { x: 0, z: 0, w: 10, d: 12 });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/rooms$/);
    expect(headerOf(0)).toBe('draft');
    // Content-Type survives alongside the workspace header
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('applies and discards against the user\'s building even from inside the draft', async () => {
    setApiWorkspace('draft');
    await applyDraft();
    await discardDraft();
    expect(headerOf(0)).toBe('main');
    expect(headerOf(1)).toBe('main');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('DELETE');
  });

  it('asks for the state of the workspace it is given, not the active one', async () => {
    setApiWorkspace('draft');
    await fetchBuildingState('main');
    expect(headerOf(0)).toBe('main');
  });

  it('runs lifecycle reports on the chosen design', async () => {
    await fetchLifecycle(OPTIONS, 'draft');
    await compareLifecycle([{ label: 'A', design: 'draft', options: OPTIONS }]);
    expect(headerOf(0)).toBe('draft');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual(OPTIONS);
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).alternatives[0].design).toBe('draft');
  });

  it('posts the brief with the optional exact figures', async () => {
    await generateDesign('2BHK', { floors: 2 });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ prompt: '2BHK', overrides: { floors: 2 } });
  });
});

describe('resync after a stale request', () => {
  it('refreshes only the workspace whose request failed', async () => {
    const draftState = { floors: [{ number: 1 }] };
    fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ detail: 'Room not found.' }), { status: 404 })))
      .mockImplementationOnce(() => ok(draftState));
    vi.stubGlobal('fetch', fetchMock);
    const main = vi.fn(), draft = vi.fn();
    const offMain = onServerState(main, 'main');
    const offDraft = onServerState(draft, 'draft');
    setApiWorkspace('draft');

    await expect(placeRoom(1, 'bedroom', { x: 0, z: 0, w: 10, d: 10 })).rejects.toThrow(/refreshed from the server/);
    expect(headerOf(1)).toBe('draft');
    expect(draft).toHaveBeenCalledWith(draftState);
    expect(main).not.toHaveBeenCalled();
    offMain(); offDraft();
  });

  it('passes the server\'s error message through', async () => {
    fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ detail: 'There is no generated design to edit — generate one first.' }), { status: 409 })));
    vi.stubGlobal('fetch', fetchMock);
    setApiWorkspace('draft');
    await expect(fetchBuildingState()).rejects.toThrow('There is no generated design to edit');
  });
});
