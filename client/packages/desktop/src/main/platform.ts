/** True when the desktop is running under a Wayland session. */
export function isWayland(): boolean {
  if (process.platform !== 'linux') return false;
  return (
    process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY
  );
}
