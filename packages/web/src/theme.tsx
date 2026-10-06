import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemePref = "system" | "light" | "dark";
interface ThemeState {
  pref: ThemePref;
  resolved: "light" | "dark";
  setPref: (p: ThemePref) => void;
}

const Ctx = createContext<ThemeState>({ pref: "system", resolved: "light", setPref: () => {} });
const KEY = "lt.theme";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* armazenamento indisponível */
  }
  return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const [systemDark, setSystemDark] = useState(mq.matches);
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [mq]);
  const resolved = pref === "system" ? (systemDark ? "dark" : "light") : pref;
  useEffect(() => {
    const root = document.documentElement;
    if (pref === "system") delete root.dataset.theme;
    else root.dataset.theme = pref;
  }, [pref]);
  const setPref = (p: ThemePref) => {
    setPrefState(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* ignora */
    }
  };
  return <Ctx.Provider value={{ pref, resolved, setPref }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

/** Lê o valor atual de uma variável CSS (cores dos gráficos acompanham o tema). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}
