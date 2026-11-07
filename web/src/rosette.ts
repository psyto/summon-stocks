/**
 * Guilloché rosettes, one per ticker. A rosette is engraved in bands; each band is one closed polar
 * wave, repeated as slightly rotated strands, the way an engraving lathe cuts a certificate's seal.
 * The ticker seeds every parameter, so GME always gets GME's rosette.
 */

export type Ink = "never" | "issued" | "trading";
export type Detail = "mark" | "cell" | "detail" | "hero";

interface Params {
  petals: number; // main wave count
  harmonic: number; // secondary wave count
  depth: number; // main wave amplitude (fraction of radius)
  depth2: number; // secondary amplitude
  twist: number; // rotation between strands, in petals
}

interface Band {
  mid: number;
  depth: number;
  depth2: number;
  petals: number;
  harmonic: number;
  strands: number;
}

/** FNV-1a, so a ticker always maps to the same rosette. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10_000) / 10_000;
  };
}

export function paramsFor(ticker: string): Params {
  const r = rng(hash(ticker));
  const petals = 7 + Math.floor(r() * 9); // 7..15
  return {
    petals,
    harmonic: petals * (2 + Math.floor(r() * 3)), // 2x..4x
    depth: 0.1 + r() * 0.08,
    depth2: 0.02 + r() * 0.04,
    twist: 0.5 + r() * 0.5,
  };
}

/** The bands a rosette is engraved with: small marks get one band, larger seals two. */
function bandsFor(p: Params, detail: Detail): Band[] {
  const outer: Band = { mid: 0.8, depth: p.depth * 0.9, depth2: p.depth2, petals: p.petals, harmonic: p.harmonic, strands: 9 };
  const inner: Band = {
    mid: 0.44,
    depth: p.depth * 0.55,
    depth2: p.depth2 * 0.6,
    petals: Math.max(5, p.petals - 3),
    harmonic: p.harmonic - p.petals,
    strands: 7,
  };
  switch (detail) {
    case "mark":
      return [{ ...outer, mid: 0.72, strands: 6 }];
    case "cell":
      return [{ ...outer, mid: 0.74, strands: 9 }];
    case "detail":
      return [
        { ...outer, strands: 16 },
        { ...inner, strands: 11 },
      ];
    case "hero":
      // no core band: the hero carries its number in the centre, like a certificate's denomination
      return [
        { ...outer, strands: 30 },
        { ...inner, mid: 0.52, strands: 22 },
      ];
  }
}

const POINTS: Record<Detail, number> = { mark: 90, cell: 150, detail: 420, hero: 900 };

function strand(b: Band, rotation: number, points: number): string {
  let d = "";
  for (let i = 0; i <= points; i++) {
    const t = (i / points) * Math.PI * 2;
    const rho = b.mid + b.depth * Math.sin(b.petals * t) + b.depth2 * Math.sin(b.harmonic * t + rotation * b.petals * 3);
    const a = t + rotation;
    d += `${i === 0 ? "M" : "L"}${(rho * Math.cos(a)).toFixed(3)} ${(rho * Math.sin(a)).toFixed(3)}`;
  }
  return d + "Z";
}

export interface RosetteOptions {
  detail: Detail;
  ink: Ink;
  /** Hero only: strands engrave themselves, one orchestrated moment. */
  draw?: boolean;
  label?: string;
}

const NS = "http://www.w3.org/2000/svg";

export function rosette(ticker: string, o: RosetteOptions): SVGSVGElement {
  const p = paramsFor(ticker);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "-1.08 -1.08 2.16 2.16");
  svg.setAttribute("class", `rosette rosette--${o.ink} rosette--${o.detail}${o.draw ? " rosette--draw" : ""}`);
  if (o.label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", o.label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "rosette__strands");
  let n = 0;
  for (const band of bandsFor(p, o.detail)) {
    const step = (Math.PI * 2 * p.twist) / (band.petals * band.strands);
    for (let i = 0; i < band.strands; i++) {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", strand(band, i * step, POINTS[o.detail]));
      if (o.draw) {
        path.setAttribute("pathLength", "1");
        path.style.setProperty("--i", String(n++));
      }
      g.appendChild(path);
    }
  }
  // the outer engraved ring every certificate seal has
  const ring = document.createElementNS(NS, "circle");
  ring.setAttribute("r", "1.02");
  ring.setAttribute("class", "rosette__ring");
  svg.append(g, ring);
  if (o.ink === "trading") {
    const big = o.detail === "hero" || o.detail === "detail";
    const seal = document.createElementNS(NS, "g");
    seal.setAttribute("class", "rosette__seal");
    const outer = document.createElementNS(NS, "circle");
    outer.setAttribute("r", big ? "0.1" : "0.2");
    const inner = document.createElementNS(NS, "circle");
    inner.setAttribute("r", big ? "0.065" : "0.13");
    inner.setAttribute("class", "rosette__seal-inner");
    seal.append(outer, inner);
    svg.appendChild(seal);
  }
  return svg;
}
