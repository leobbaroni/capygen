/**
 * Window geometry persistence. Stored in the `settings` table under a raw key so
 * there is one database and no side-car JSON file to keep in sync.
 *
 * Off-screen guard: a window restored onto a monitor that no longer exists is
 * invisible and reads as a crash. `clampToDisplays` drops the saved position
 * when no display contains it, which makes Electron centre the window instead.
 */
import { WindowStateSchema, type WindowState } from "@capygen/shared";

export const WINDOW_STATE_KEY = "window.state";

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_WINDOW_STATE: WindowState = WindowStateSchema.parse({});

export function parseWindowState(raw: unknown): WindowState {
  const parsed = WindowStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_WINDOW_STATE;
}

/**
 * Keep the position only when the window's top-left lands inside some display's
 * work area (with a small margin so a title bar dragged just off the edge still
 * counts). Returns state without x/y otherwise.
 */
export function clampToDisplays(
  state: WindowState,
  displays: readonly DisplayBounds[],
): WindowState {
  if (state.x === undefined || state.y === undefined) return state;
  const x = state.x;
  const y = state.y;
  const visible = displays.some(
    (d) => x >= d.x - 32 && y >= d.y - 32 && x < d.x + d.width - 32 && y < d.y + d.height - 32,
  );
  if (visible) return state;
  const { x: _x, y: _y, ...rest } = state;
  return rest;
}

export interface WindowLike {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isMinimized(): boolean;
  getNormalBounds(): DisplayBounds;
}

/** Read the geometry worth saving: normal bounds plus the maximized flag. */
export function captureWindowState(win: WindowLike): WindowState | null {
  if (win.isDestroyed()) return null;
  const bounds = win.getNormalBounds();
  return WindowStateSchema.parse({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(640, Math.round(bounds.width)),
    height: Math.max(480, Math.round(bounds.height)),
    maximized: win.isMaximized(),
  });
}
