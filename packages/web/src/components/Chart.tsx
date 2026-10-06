import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { cssVar, useTheme } from "../theme";

export interface ChartSeries {
  label: string;
  /** Variável CSS da cor (ex.: "--s1"). */
  color: string;
  fill?: boolean;
}

/**
 * Série temporal (uPlot, canvas): linhas de 2px, grade fina, um eixo Y, crosshair com os valores
 * de todas as séries na legenda. Cores e grade são lidas das variáveis CSS e recriadas ao trocar
 * o tema. `data` = [x (segundos), y1, y2, ...].
 */
export function TimeChart({
  title,
  unit,
  series,
  data,
  height = 200,
  yMax,
}: {
  title: string;
  unit: string;
  series: ChartSeries[];
  data: (number | null)[][];
  height?: number;
  yMax?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const { resolved } = useTheme();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const axis = cssVar("--muted");
    const grid = cssVar("--grid");
    const fmtV = (v: number | null) =>
      v === null || v === undefined ? "—" : `${+v.toFixed(2)} ${unit}`;
    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height,
      title: undefined,
      scales: {
        x: { time: false },
        y: { range: (_u, _min, max) => [0, yMax ?? (max > 0 ? max * 1.1 : 1)] },
      },
      axes: [
        {
          stroke: axis,
          grid: { show: false },
          ticks: { stroke: grid, width: 1 },
          values: (_u, vals) =>
            vals.map((v) =>
              v < 60 ? `${v}s` : `${Math.floor(v / 60)}m${v % 60 ? `${v % 60}s` : ""}`,
            ),
          font: "11px system-ui",
        },
        {
          stroke: axis,
          grid: { stroke: grid, width: 1 },
          ticks: { show: false },
          size: 48,
          font: "11px system-ui",
          label: unit,
          labelSize: 14,
          labelFont: "11px system-ui",
        },
      ],
      cursor: { drag: { x: false, y: false }, points: { size: 8 } },
      legend: { show: true, live: true },
      series: [
        { label: "t", value: (_u, v) => (v === null ? "—" : `${v}s`) },
        ...series.map((s) => {
          const c = cssVar(s.color);
          return {
            label: s.label,
            stroke: c,
            width: 2,
            fill: s.fill ? `${c}1a` : undefined,
            points: { show: false },
            value: (_u: uPlot, v: number | null) => fmtV(v),
            spanGaps: false,
          };
        }),
      ],
    };
    const u = new uPlot(opts, data as uPlot.AlignedData, el);
    plot.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
    // recria ao trocar tema, séries ou unidade; os dados são atualizados no efeito abaixo
  }, [resolved, unit, height, yMax, series.map((s) => s.label + s.color).join()]);

  useEffect(() => {
    plot.current?.setData(data as uPlot.AlignedData);
  }, [data]);

  return (
    <figure className="chart" style={{ margin: 0 }} aria-label={title}>
      <div ref={host} />
    </figure>
  );
}
