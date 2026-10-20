import { useEffect } from "react";
import { shortcutKey } from "@/lib/keys";
import { useUi } from "@/store/ui";
import { COMMANDS } from "./commands";

/** "Ctrl+Shift+F" for a key press (physical keys: works on any keyboard layout). */
export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = shortcutKey(e);
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return "";
  parts.push(key);
  return parts.join("+");
}

/** Global shortcuts of the commands (an editor that handled a key first wins). */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const combo = comboOf(e);
      if (!combo) return;
      // A dialog owns the keyboard (Settings may still close with its own shortcut).
      const ui = useUi.getState();
      if (ui.dialog) return;
      const cmd = COMMANDS.find((c) => c.shortcut === combo);
      if (!cmd) return;
      if (ui.settingsOpen && cmd.id !== "settings") return;
      e.preventDefault();
      if (!cmd.enabled || cmd.enabled()) cmd.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
