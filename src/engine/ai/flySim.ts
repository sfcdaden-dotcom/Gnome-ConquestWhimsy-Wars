/**
 * A leaky integrate-and-fire simulator for the Fly's circuit — a TypeScript
 * port of the Shiu et al. (2024) whole-brain model (flybrain/vendor/shiu2024
 * in the FlyBrain repository), run on the subcircuit cut out of the FlyWire
 * connectome by flybrain/extract_circuit.py.
 *
 * Per neuron:  dv/dt = (v0 − v + g) / tMembrane,   dg/dt = −g / tSynapse
 * frozen while refractory; a spike when v > vThreshold resets v and g and
 * adds `weight × wSynapse` to each target's g after tDelay. Stimulated input
 * neurons receive Poisson events that each add wInput to v (enough to force a
 * spike) and have no refractory period, as in the original.
 *
 * Integration is exact for the linear system over each dt step. Randomness
 * comes from a seeded generator, so the same inputs and seed give the same
 * spikes — the engine's determinism holds with the brain in the loop.
 */

export type InputChannel = 'sugar' | 'bitter' | 'loom' | 'object';
export type OutputChannel = 'feed' | 'escape' | 'approach' | 'retreat';
export const INPUT_CHANNELS: readonly InputChannel[] = ['sugar', 'bitter', 'loom', 'object'];
export const OUTPUT_CHANNELS: readonly OutputChannel[] = ['feed', 'escape', 'approach', 'retreat'];

export interface CircuitParams {
  v0: number;
  vReset: number;
  vThreshold: number;
  tMembrane: number;
  tSynapse: number;
  tRefractory: number;
  tDelay: number;
  wSynapse: number;
  wInput: number;
}

/** A circuit ready to simulate: outgoing connections grouped per neuron. */
export interface Circuit {
  neurons: number;
  params: CircuitParams;
  channels: Record<InputChannel | OutputChannel, number[]>;
  /** CSR: connections of neuron i are targets/weights[start[i] .. start[i+1]). */
  start: Int32Array;
  targets: Int32Array;
  weights: Float32Array;
}

/** The packed form the circuit ships in (see flyCircuitData.ts). */
export interface CircuitData {
  source: string;
  validation: Record<string, number>;
  neurons: number;
  params: CircuitParams;
  channels: Record<InputChannel | OutputChannel, number[]>;
  /** base64, little-endian: int32 CSR offsets, uint16 targets, int16 signed synapse counts. */
  start: string;
  targets: string;
  weights: string;
  /** Whole-brain output rates (Hz) per input pattern, for validation. */
  response: Array<Record<string, number>>;
}

/** Unpack the shipped circuit. */
export function loadCircuit(d: CircuitData): Circuit {
  const start = new Int32Array(bytes(d.start).buffer);
  const targets = Int32Array.from(new Uint16Array(bytes(d.targets).buffer));
  const counts = new Int16Array(bytes(d.weights).buffer);
  const weights = new Float32Array(counts.length);
  for (let e = 0; e < counts.length; e++) weights[e] = counts[e] * d.params.wSynapse;
  return { neurons: d.neurons, params: d.params, channels: d.channels, start, targets, weights };
}

function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build the CSR form from parallel pre/post/weight lists (weight in synapses, signed). */
export function buildCircuit(raw: {
  neurons: number;
  params: CircuitParams;
  channels: Record<InputChannel | OutputChannel, number[]>;
  pre: ArrayLike<number>;
  post: ArrayLike<number>;
  weight: ArrayLike<number>;
}): Circuit {
  const n = raw.neurons;
  const start = new Int32Array(n + 1);
  for (let e = 0; e < raw.pre.length; e++) start[raw.pre[e] + 1]++;
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n);
  const targets = new Int32Array(raw.pre.length);
  const weights = new Float32Array(raw.pre.length);
  for (let e = 0; e < raw.pre.length; e++) {
    const slot = fill[raw.pre[e]]++;
    targets[slot] = raw.post[e];
    weights[slot] = raw.weight[e] * raw.params.wSynapse;
  }
  return { neurons: n, params: raw.params, channels: raw.channels, start, targets, weights };
}

export interface SimOptions {
  /** Simulated time in ms. */
  duration: number;
  /** Integration step in ms (the original uses 0.1). */
  dt?: number;
  seed: number;
}

/** Stimulate the input channels at the given rates (Hz); return each output channel's mean rate (Hz). */
export function simulate(
  c: Circuit,
  rates: Partial<Record<InputChannel, number>>,
  opts: SimOptions,
): Record<OutputChannel, number> {
  const spikes = simulateCounts(c, rates, opts);
  const seconds = opts.duration / 1000;
  const result = {} as Record<OutputChannel, number>;
  for (const ch of OUTPUT_CHANNELS) {
    const ids = c.channels[ch];
    let total = 0;
    for (const i of ids) total += spikes[i];
    result[ch] = ids.length > 0 ? total / ids.length / seconds : 0;
  }
  return result;
}

/** Spike count per neuron over the run. */
export function simulateCounts(
  c: Circuit,
  rates: Partial<Record<InputChannel, number>>,
  opts: SimOptions,
): Uint32Array {
  const p = c.params;
  const dt = opts.dt ?? 0.1;
  const steps = Math.round(opts.duration / dt);
  const n = c.neurons;
  const v = new Float64Array(n).fill(p.v0);
  const g = new Float64Array(n);
  const refractoryUntil = new Int32Array(n).fill(-1);
  const spikes = new Uint32Array(n);

  // Per-step Poisson probability per stimulated neuron.
  const stimProb = new Float64Array(n);
  const noRefractory = new Uint8Array(n);
  for (const ch of INPUT_CHANNELS) {
    for (const i of c.channels[ch]) {
      noRefractory[i] = 1;
      stimProb[i] = Math.max(stimProb[i], ((rates[ch] ?? 0) * dt) / 1000);
    }
  }
  const stimulated: number[] = [];
  for (let i = 0; i < n; i++) if (stimProb[i] > 0) stimulated.push(i);

  // Exact one-step propagators for the linear (v, g) system.
  const em = Math.exp(-dt / p.tMembrane);
  const es = Math.exp(-dt / p.tSynapse);
  const a = p.tSynapse / (p.tSynapse - p.tMembrane);

  // Delayed synaptic input: a ring of per-neuron buffers, tDelay deep.
  const delay = Math.max(1, Math.round(p.tDelay / dt));
  const ring: Float64Array[] = Array.from({ length: delay + 1 }, () => new Float64Array(n));
  const refractorySteps = Math.round(p.tRefractory / dt);
  const random = mulberry32(opts.seed);
  const spiking: number[] = [];
  /** Neurons with a delivery waiting in each ring slot, so a step touches only those. */
  const pending: number[][] = Array.from({ length: ring.length }, () => []);

  // Each step follows Brian2's default schedule: integrate, threshold,
  // synapses (delayed deliveries and Poisson input), reset. Neurons at rest
  // with no input are skipped: their state is a fixed point.
  for (let t = 0; t < steps; t++) {
    // Integrate and threshold in one pass (a neuron's own spike test only
    // needs its own freshly integrated v).
    spiking.length = 0;
    for (let i = 0; i < n; i++) {
      if (refractoryUntil[i] >= t) continue; // v and g frozen while refractory
      const gi = g[i];
      const x0 = v[i] - p.v0;
      if (gi === 0 && x0 === 0) continue; // at rest: nothing changes
      const vi = p.v0 + a * gi * es + (x0 - a * gi) * em;
      v[i] = vi;
      g[i] = gi * es;
      if (vi > p.vThreshold) spiking.push(i);
    }

    // Synapses: deliveries due now, then Poisson input.
    const arriving = ring[t % ring.length];
    const due = pending[t % ring.length];
    for (const i of due) {
      g[i] += arriving[i];
      arriving[i] = 0;
    }
    due.length = 0;
    for (const i of stimulated) if (random() < stimProb[i]) v[i] += p.wInput;

    // Resets, and schedule each spike's deliveries tDelay from now.
    const later = (t + delay) % ring.length;
    const out = ring[later];
    const outList = pending[later];
    for (const i of spiking) {
      spikes[i]++;
      v[i] = p.vReset;
      g[i] = 0;
      refractoryUntil[i] = noRefractory[i] ? -1 : t + refractorySteps;
      for (let e = c.start[i]; e < c.start[i + 1]; e++) {
        const j = c.targets[e];
        if (out[j] === 0) outList.push(j);
        out[j] += c.weights[e];
      }
    }
  }

  return spikes;
}

/** Small, fast, seedable PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
