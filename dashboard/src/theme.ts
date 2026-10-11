// Light, dark, or follow the system. The choice stays in this browser only.
export type ThemeChoice = "system" | "light" | "dark";
const KEY = "kmcp.theme";

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice = getTheme()) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function setTheme(choice: ThemeChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* private mode: the choice applies for this visit only */
  }
  applyTheme(choice);
}
