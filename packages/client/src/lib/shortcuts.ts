/** The app's keyboard shortcuts, in one table that both the global handler and the
    Settings ▸ Keyboard reference read from, so the list can no longer drift (SET-01). */
import { useSettings } from "./settings";

export interface ShortcutRow { keys: string; label: string; /** dynamic rows render their current value */ dynamic?: "sendOnEnter" }

export function shortcutRows(): ShortcutRow[] {
  const s = useSettings.getState();
  return [
    {
      keys: s.sendOnEnter ? "Enter" : "Shift+Enter",
      label: s.sendOnEnter ? "Send the message" : "Send the message (Enter sends is off)",
      dynamic: "sendOnEnter",
    },
    { keys: s.sendOnEnter ? "Shift+Enter" : "Enter", label: "Insert a newline", dynamic: "sendOnEnter" },
    { keys: "Ctrl/⌘ + K", label: "Focus the composer" },
    { keys: "Ctrl/⌘ + B", label: "Collapse or expand the sidebar" },
    { keys: "Ctrl/⌘ + N", label: "New session in the current workspace" },
    { keys: "Ctrl/⌘ + .", label: "Stop the current run" },
    { keys: "Ctrl/⌘ + ,", label: "Open settings" },
    { keys: "F2", label: "Rename the current session" },
    { keys: "/", label: "Search sessions" },
    { keys: "Alt + ↑ / ↓", label: "Previous / next session" },
    { keys: "Esc", label: "Close the open menu or dialog" },
  ];
}
