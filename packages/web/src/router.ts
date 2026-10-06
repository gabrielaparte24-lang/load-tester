import { useEffect, useState } from "react";

/** Roteador mínimo por hash (#/rota/param?x=1): funciona servido de qualquer pasta, sem config. */
export interface Route {
  path: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/cenarios";
  const [p, q] = raw.split("?");
  return {
    path: p!.split("/").filter(Boolean).map(decodeURIComponent),
    query: new URLSearchParams(q ?? ""),
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(path: string): void {
  window.location.hash = path;
}

export const href = (path: string) => `#${path}`;
