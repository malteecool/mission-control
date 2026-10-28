// Runs in the window before each page loads (main.rs).
window.__MISSION_CONTROL_DESKTOP__ = true;

// The browser's right-click menu (Back, Reload, Save as, Print…) makes no sense in an app window. Keep it only where
// it helps: in text fields and on selected text, for cut, copy and paste. The page's own menus (web/src/components/
// ContextMenu.tsx) call preventDefault themselves, so this only decides what an unhandled right-click shows.
window.addEventListener("contextmenu", (e) => {
  if (e.defaultPrevented) return;
  const t = e.target instanceof Element ? e.target : null;
  const editable = t?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])");
  const selected = String(window.getSelection() ?? "").trim() !== "";
  if (!editable && !selected) e.preventDefault();
});
