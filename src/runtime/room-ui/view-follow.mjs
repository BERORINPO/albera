// Who moves the view of the room: Bero or the person. In 'follow' Bero's looks move the canvas. In 'own' they are only
// remembered, so a person looking at another camera is not pulled away. Moving the view by hand switches to 'own' by
// itself; 'follow' goes back to where Bero looked last. Pure: the canvas is handed in, so this runs without a browser.
export const VIEW_FOLLOW = 'follow';
export const VIEW_OWN = 'own';

export function createViewFollow({ onChange = () => {}, home = () => {} } = {}) {
  let mode = VIEW_FOLLOW;
  let latest = null;
  const change = (next) => {
    if (next === mode) return false;
    mode = next;
    onChange(mode);
    return true;
  };
  return {
    mode: () => mode,
    look(apply) {
      latest = apply;
      if (mode === VIEW_FOLLOW) apply();
    },
    userMoved() { change(VIEW_OWN); },
    /** What Bero looked at is gone (a camera was removed): going back then goes home. */
    forget() { latest = null; },
    follow() { if (change(VIEW_FOLLOW)) (latest ?? home)(); },
  };
}

/** The canvas as Bero should see it: the same canvas, except that its looks go through the view mode. */
export const followingCanvas = (canvas, view) => ({
  ...canvas,
  lookAt: (...args) => view.look(() => canvas.lookAt(...args)),
  lookAll: (...args) => view.look(() => canvas.lookAll(...args)),
});

/**
 * How many VMs wait for the person: a camera in the wait tone, or a question card nobody answered. A camera and its own
 * card are one thing to do, and a camera whose claim the host is still checking needs nobody. toneOf is null while the
 * camera part is a stub.
 */
export function waitingCount(vms, toneOf, cardVmIds = []) {
  const cameras = toneOf ? vms.filter((vm) => toneOf(vm) === 'wait' && vm?.check?.state !== 'checking').map((vm) => vm.vmId) : [];
  return new Set([...cameras, ...cardVmIds]).size;
}
