import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { LiveProvider, useLive } from "./live";
import { ComparePage } from "./pages/Compare";
import { LivePage } from "./pages/Live";
import { ResultsPage } from "./pages/Results";
import { ScenariosPage } from "./pages/Scenarios";
import { SettingsPage } from "./pages/Settings";
import { href, useRoute } from "./router";
import { ThemeProvider, useTheme } from "./theme";

function App() {
  const route = useRoute();
  const { active } = useLive();
  const { resolved, setPref } = useTheme();
  const [section, param] = route.path;
  const tabs: [string, string, string][] = [
    ["cenarios", "/cenarios", "Cenários"],
    ["ao-vivo", active ? `/ao-vivo/${encodeURIComponent(active.id)}` : "/ao-vivo", "Ao vivo"],
    ["resultados", "/resultados", "Resultados"],
    ["comparar", "/comparar", "Comparar"],
    ["config", "/config", "Configurações"],
  ];
  return (
    <>
      <a href="#conteudo" className="sr-only">
        Ir para o conteúdo
      </a>
      <header className="app">
        <a className="brand" href={href("/cenarios")}>
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="var(--accent)" />
            <path
              d="M6 22l6-7 5 4 9-11"
              stroke="white"
              strokeWidth="3"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          lt
        </a>
        <nav className="tabs" aria-label="Seções">
          {tabs.map(([key, to, label]) => (
            <a key={key} href={href(to)} aria-current={section === key ? "page" : undefined}>
              {key === "ao-vivo" && active ? (
                <span className="live-dot" aria-label="execução em andamento" />
              ) : null}
              {label}
            </a>
          ))}
        </nav>
        <button
          type="button"
          className="ghost"
          onClick={() => setPref(resolved === "dark" ? "light" : "dark")}
          aria-label={`Mudar para tema ${resolved === "dark" ? "claro" : "escuro"}`}
          title="Alternar tema"
        >
          {resolved === "dark" ? "☀" : "☾"}
        </button>
      </header>
      <main id="conteudo" tabIndex={-1}>
        {section === "ao-vivo" ? (
          <LivePage id={param} />
        ) : section === "resultados" ? (
          <ResultsPage />
        ) : section === "comparar" ? (
          <ComparePage
            a={route.query.get("a") ?? undefined}
            b={route.query.get("b") ?? undefined}
          />
        ) : section === "config" ? (
          <SettingsPage />
        ) : (
          <ScenariosPage id={section === "cenarios" ? param : undefined} />
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <LiveProvider>
        <App />
      </LiveProvider>
    </ThemeProvider>
  </StrictMode>,
);
