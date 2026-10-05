/**
 * Gerador pseudoaleatório determinístico (sfc32) com semente derivada por iteração.
 *
 * Cada iteração k recebe seu próprio fluxo de números a partir de (seed, k). Assim os dados
 * gerados são idênticos entre execuções com a mesma semente, independentemente da ordem em
 * que as respostas chegam ou de quantas iterações rodam em paralelo.
 */
export type Rng = () => number;

/** splitmix32: espalha bits de uma semente de 32 bits. */
function splitmix32(a: number): () => number {
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

function sfc32(a: number, b: number, c: number, d: number): Rng {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function createRng(seed: number, stream = 0): Rng {
  const mix = splitmix32((seed ^ Math.imul(stream + 1, 0x85ebca6b)) >>> 0);
  const rng = sfc32(mix(), mix(), mix(), mix());
  for (let i = 0; i < 12; i++) rng(); // aquece o estado
  return rng;
}

/** Inteiro uniforme em [min, max] (inclusivo). */
export function randInt(rng: Rng, min: number, max: number): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function uuidV4(rng: Rng): string {
  const b = new Array<number>(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(rng() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
