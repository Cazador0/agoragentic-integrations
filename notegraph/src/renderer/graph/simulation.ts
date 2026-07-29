/**
 * Force-directed layout simulation (d3-force-style semi-implicit Euler):
 * Barnes–Hut repulsion, springs along links, center gravity, velocity decay,
 * and alpha cooling per SimulationOptions. Fully deterministic — initial
 * placement comes from a phyllotaxis spiral perturbed by a string hash of the
 * node id, never from Math.random.
 */

import type { IForceSimulation, SimLink, SimNode, SimulationOptions } from '../../shared/types';
import { DEFAULT_SIMULATION_OPTIONS } from '../../shared/types';
import { GOLDEN_ANGLE, buildQuadTree } from './quadtree';

const DEFAULT_REHEAT_ALPHA = 0.6;
const SPIRAL_SPACING = 30;
const SPIRAL_BASE_RADIUS = 4;

function hashString(text: string): number {
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (let position = 0; position < text.length; position++) {
    hash ^= text.charCodeAt(position);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function seedPosition(id: string, index: number): { x: number; y: number } {
  const safeIndex = Number.isFinite(index) && index >= 0 ? index : 0;
  const hash = hashString(id);
  const angleJitter = ((hash & 0xffff) / 0xffff - 0.5) * 0.6;
  const radiusJitter = (((hash >>> 16) & 0xffff) / 0xffff - 0.5) * 4;
  const radius = SPIRAL_SPACING * Math.sqrt(safeIndex) + SPIRAL_BASE_RADIUS + radiusJitter;
  const angle = safeIndex * GOLDEN_ANGLE + angleJitter;
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

function effectiveMass(node: SimNode): number {
  return Number.isFinite(node.mass) && node.mass > 0 ? node.mass : 1;
}

export class ForceSimulation implements IForceSimulation {
  nodes: SimNode[] = [];
  links: SimLink[] = [];
  alpha = 1;
  options: SimulationOptions;

  constructor(options?: Partial<SimulationOptions>) {
    const merged: SimulationOptions = { ...DEFAULT_SIMULATION_OPTIONS };
    if (options !== undefined) {
      for (const key of Object.keys(DEFAULT_SIMULATION_OPTIONS) as Array<keyof SimulationOptions>) {
        const value = options[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          merged[key] = value;
        }
      }
    }
    this.options = merged;
  }

  setGraph(nodes: SimNode[], links: SimLink[]): void {
    this.nodes = nodes;
    this.links = links.filter(
      (link) =>
        Number.isInteger(link.source) &&
        Number.isInteger(link.target) &&
        link.source >= 0 &&
        link.source < nodes.length &&
        link.target >= 0 &&
        link.target < nodes.length &&
        link.source !== link.target,
    );
  }

  tick(): number {
    const {
      alphaMin,
      alphaDecay,
      theta,
      repulsion,
      springStrength,
      springLength,
      centerGravity,
      velocityDecay,
    } = this.options;
    if (this.alpha < alphaMin) return this.alpha;
    this.alpha += (0 - this.alpha) * alphaDecay;

    const nodes = this.nodes;
    const nodeCount = nodes.length;
    if (nodeCount === 0) return this.alpha;

    const forceX = new Float64Array(nodeCount);
    const forceY = new Float64Array(nodeCount);

    const tree = buildQuadTree(nodes);
    const accumulator = { fx: 0, fy: 0 };
    for (let index = 0; index < nodeCount; index++) {
      const node = nodes[index];
      if (node === undefined || node.fixed) continue;
      accumulator.fx = 0;
      accumulator.fy = 0;
      tree.accumulateForce(index, theta, repulsion, accumulator);
      forceX[index] = accumulator.fx;
      forceY[index] = accumulator.fy;
    }

    for (const link of this.links) {
      const source = nodes[link.source];
      const target = nodes[link.target];
      if (source === undefined || target === undefined) continue;
      const deltaX = target.x - source.x;
      const deltaY = target.y - source.y;
      const distance = Math.hypot(deltaX, deltaY);
      // Coincident endpoints give the spring no direction; the quadtree's
      // deterministic separation resolves the overlap on this same tick.
      if (!(distance > 1e-9)) continue;
      const restLength = Number.isFinite(link.restLength) ? link.restLength : springLength;
      const linkStrength = Number.isFinite(link.strength) ? link.strength : 1;
      const magnitude = springStrength * linkStrength * (distance - restLength);
      const pullX = (magnitude * deltaX) / distance;
      const pullY = (magnitude * deltaY) / distance;
      forceX[link.source] = (forceX[link.source] ?? 0) + pullX;
      forceY[link.source] = (forceY[link.source] ?? 0) + pullY;
      forceX[link.target] = (forceX[link.target] ?? 0) - pullX;
      forceY[link.target] = (forceY[link.target] ?? 0) - pullY;
    }

    for (let index = 0; index < nodeCount; index++) {
      const node = nodes[index];
      if (node === undefined) continue;
      if (node.fixed) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      let totalForceX = (forceX[index] ?? 0) - centerGravity * node.x;
      let totalForceY = (forceY[index] ?? 0) - centerGravity * node.y;
      // Malformed input can surface as non-finite forces; clamping them to
      // zero keeps one bad node from corrupting the whole layout.
      if (!Number.isFinite(totalForceX)) totalForceX = 0;
      if (!Number.isFinite(totalForceY)) totalForceY = 0;
      const mass = effectiveMass(node);
      node.vx = (node.vx + (this.alpha * totalForceX) / mass) * velocityDecay;
      node.vy = (node.vy + (this.alpha * totalForceY) / mass) * velocityDecay;
      if (!Number.isFinite(node.vx)) node.vx = 0;
      if (!Number.isFinite(node.vy)) node.vy = 0;
      node.x += node.vx;
      node.y += node.vy;
    }

    return this.alpha;
  }

  reheat(alpha: number = DEFAULT_REHEAT_ALPHA): void {
    const target = Number.isFinite(alpha) ? alpha : DEFAULT_REHEAT_ALPHA;
    this.alpha = Math.min(1, Math.max(0, Math.max(this.alpha, target)));
  }

  isSettled(): boolean {
    return this.alpha < this.options.alphaMin;
  }
}
