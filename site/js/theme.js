// Runs in the head, before the first paint, so a saved choice never flashes the other theme.
try {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {
  /* storage can be blocked; the system setting then decides */
}
