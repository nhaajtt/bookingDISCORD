// One place that says what time it is, so tests can fix and advance it. Every handler and job calls now().
let source = Date.now;

export const now = () => source();

// setClock(fn) replaces the clock; setClock() restores the real one
export function setClock(fn) {
  source = typeof fn === "function" ? fn : Date.now;
}
