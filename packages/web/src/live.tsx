import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, type ActiveRun, type LogLine, type ProgressSnapshot, type RunRow } from "./api";

/**
 * Estado em tempo real: um único EventSource (/api/events) alimenta toda a interface com a
 * execução ativa, seu histórico por segundo e os logs. Reconecta sozinho; ao reconectar, o
 * evento "hello" e GET /api/runs/:id recompõem o estado.
 */
interface LiveState {
  connected: boolean;
  active: ActiveRun | null;
  history: ProgressSnapshot[];
  logs: LogLine[];
  /** Última execução terminada (para avisar a tela ao vivo). */
  finished: RunRow | null;
  /** Incrementado a cada mudança relevante (listas podem recarregar). */
  version: number;
}

const Ctx = createContext<LiveState>({
  connected: false,
  active: null,
  history: [],
  logs: [],
  finished: null,
  version: 0,
});

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [history, setHistory] = useState<ProgressSnapshot[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [finished, setFinished] = useState<RunRow | null>(null);
  const [version, setVersion] = useState(0);
  const activeId = useRef<string | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/events");
    const load = async (id: string) => {
      try {
        const r = await api<{
          live?: ActiveRun & { history: ProgressSnapshot[]; logs: LogLine[] };
        }>(`/api/runs/${encodeURIComponent(id)}`);
        if (r.live && activeId.current === id) {
          setHistory(r.live.history);
          setLogs(r.live.logs);
        }
      } catch {
        /* a execução pode ter terminado entre os eventos */
      }
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("hello", (e) => {
      const { active: list } = JSON.parse((e as MessageEvent).data) as { active: ActiveRun[] };
      const a = list[0] ?? null;
      activeId.current = a?.id ?? null;
      setActive(a);
      if (a) void load(a.id);
      else {
        setHistory([]);
        setLogs([]);
      }
    });
    es.addEventListener("run-started", (e) => {
      const { run } = JSON.parse((e as MessageEvent).data) as { run: ActiveRun };
      activeId.current = run.id;
      setActive(run);
      setHistory([]);
      setLogs([]);
      setFinished(null);
      setVersion((v) => v + 1);
    });
    es.addEventListener("progress", (e) => {
      const { runId, p } = JSON.parse((e as MessageEvent).data) as {
        runId: string;
        p: ProgressSnapshot;
      };
      if (runId !== activeId.current) return;
      setHistory((h) => [...h, p]);
      setActive((a) => (a ? { ...a, last: p } : a));
    });
    es.addEventListener("log", (e) => {
      const { runId, line } = JSON.parse((e as MessageEvent).data) as {
        runId: string;
        line: LogLine;
      };
      if (runId !== activeId.current) return;
      setLogs((l) => [...l.slice(-499), line]);
    });
    es.addEventListener("run-finished", (e) => {
      const { run } = JSON.parse((e as MessageEvent).data) as { run: RunRow };
      setFinished(run);
      if (run.id === activeId.current) {
        activeId.current = null;
        setActive(null);
      }
      setVersion((v) => v + 1);
    });
    es.addEventListener("scenarios-changed", () => setVersion((v) => v + 1));
    return () => es.close();
  }, []);

  const value = useMemo(
    () => ({ connected, active, history, logs, finished, version }),
    [connected, active, history, logs, finished, version],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);
