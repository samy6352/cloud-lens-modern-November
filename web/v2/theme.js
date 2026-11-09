// Runs before first paint (blocking, external so CSP stays script-src 'self').
// Mirrors src/lib/prefs.ts: reads the persisted preferences and sets classes on <html>.
(function () {
  try {
    var raw = localStorage.getItem("cl.v3.prefs");
    var prefs = raw ? JSON.parse(raw) : {};
    var theme = prefs.theme || "system";
    var dark = theme === "dark" ||
      (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.dataset.density = prefs.density === "comfortable" ? "comfortable" : "compact";
  } catch (e) {
    /* storage blocked: fall back to the light, compact default */
  }
})();
