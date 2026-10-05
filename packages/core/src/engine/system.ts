import os from "node:os";

export interface SystemSample {
  /** CPU total da máquina (0–100%) no último intervalo. */
  cpu: number;
  /** Memória em uso na máquina (0–100%). */
  memPct: number;
  /** Memória residente deste processo (inclui os workers), em MB. */
  rssMb: number;
}

/** Amostra CPU/memória da máquina local por diferença dos contadores de os.cpus(). */
export class SystemSampler {
  private last = snapshot();

  sample(): SystemSample {
    const now = snapshot();
    const idle = now.idle - this.last.idle;
    const total = now.total - this.last.total;
    this.last = now;
    const total0 = os.totalmem();
    return {
      cpu: total > 0 ? round1((1 - idle / total) * 100) : 0,
      memPct: round1(((total0 - os.freemem()) / total0) * 100),
      rssMb: round1(process.memoryUsage.rss() / 1024 / 1024),
    };
  }
}

function snapshot() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
