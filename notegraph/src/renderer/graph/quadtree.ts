/**
 * Barnes–Hut quadtree over SimNodes, rebuilt once per simulation tick.
 * Cells aggregate total mass and center of mass; force traversal accepts a
 * cell as a point-mass approximation when s / d < theta (s = cell width),
 * otherwise it recurses; leaves interact exactly pairwise.
 */

import type { SimNode } from '../../shared/types';

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Plummer-style softening keeps the repulsion denominator strictly positive,
// so exactly coincident nodes produce zero force instead of NaN.
const SOFTENING = 0.01;

// Beyond this depth remaining points are near-coincident; bucket them in one
// leaf instead of subdividing forever.
const MAX_DEPTH = 40;

export interface ForceAccumulator {
  fx: number;
  fy: number;
}

class QuadCell {
  mass = 0;
  centerOfMassX = 0;
  centerOfMassY = 0;
  /** Head of the intrusive linked list of node indices when this is a leaf. */
  head = -1;
  leaf = true;
  northWest: QuadCell | null = null;
  northEast: QuadCell | null = null;
  southWest: QuadCell | null = null;
  southEast: QuadCell | null = null;

  constructor(
    readonly centerX: number,
    readonly centerY: number,
    readonly halfExtent: number,
  ) {}
}

function effectiveMass(node: SimNode): number {
  return Number.isFinite(node.mass) && node.mass > 0 ? node.mass : 1;
}

function addPairForce(
  node: SimNode,
  otherMass: number,
  otherX: number,
  otherY: number,
  repulsion: number,
  out: ForceAccumulator,
): void {
  const deltaX = node.x - otherX;
  const deltaY = node.y - otherY;
  const softened = deltaX * deltaX + deltaY * deltaY + SOFTENING;
  const scale = (repulsion * effectiveMass(node) * otherMass) / (softened * Math.sqrt(softened));
  const forceX = scale * deltaX;
  const forceY = scale * deltaY;
  if (Number.isFinite(forceX)) out.fx += forceX;
  if (Number.isFinite(forceY)) out.fy += forceY;
}

function createRootCell(nodes: SimNode[]): QuadCell | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let sawFiniteNode = false;
  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    sawFiniteNode = true;
    if (node.x < minX) minX = node.x;
    if (node.x > maxX) maxX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.y > maxY) maxY = node.y;
  }
  if (!sawFiniteNode) return null;
  const halfExtent = Math.max((maxX - minX) / 2, (maxY - minY) / 2, 0.5);
  return new QuadCell((minX + maxX) / 2, (minY + maxY) / 2, halfExtent);
}

function positionKey(x: number, y: number): string {
  return `${x}|${y}`;
}

/**
 * Nudge non-fixed nodes off exactly shared positions so repulsion has a
 * direction to push along. The offset is derived from the node index (no
 * randomness) to keep layouts reproducible. Fixed nodes are never moved.
 */
function separateCoincidentNodes(nodes: SimNode[]): void {
  const occupied = new Set<string>();
  for (const node of nodes) {
    if (node.fixed && Number.isFinite(node.x) && Number.isFinite(node.y)) {
      occupied.add(positionKey(node.x, node.y));
    }
  }
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node === undefined || node.fixed) continue;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    let key = positionKey(node.x, node.y);
    for (let attempt = 1; occupied.has(key) && attempt <= 8; attempt++) {
      const angle = GOLDEN_ANGLE * (index + 1);
      const magnitude = 0.001 * attempt * (1 + (index % 16));
      node.x += Math.cos(angle) * magnitude;
      node.y += Math.sin(angle) * magnitude;
      key = positionKey(node.x, node.y);
    }
    occupied.add(key);
  }
}

export class QuadTree {
  private readonly nodes: SimNode[];
  private readonly nextIndex: number[];
  private readonly root: QuadCell | null;

  constructor(nodes: SimNode[]) {
    this.nodes = nodes;
    this.nextIndex = new Array<number>(nodes.length).fill(-1);
    this.root = createRootCell(nodes);
  }

  insert(index: number): void {
    if (this.root === null) return;
    const node = this.nodes[index];
    if (node === undefined) return;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
    this.insertInto(this.root, index, node.x, node.y, 0);
  }

  computeMass(): void {
    if (this.root !== null) this.computeCellMass(this.root);
  }

  /** Accumulate the repulsive force acting on nodes[nodeIndex] into `out`. */
  accumulateForce(nodeIndex: number, theta: number, repulsion: number, out: ForceAccumulator): void {
    if (this.root === null) return;
    const node = this.nodes[nodeIndex];
    if (node === undefined) return;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
    this.accumulateFromCell(this.root, node, nodeIndex, theta, repulsion, out);
  }

  private insertInto(cell: QuadCell, index: number, x: number, y: number, depth: number): void {
    if (!cell.leaf) {
      this.insertInto(this.childFor(cell, x, y), index, x, y, depth + 1);
      return;
    }
    if (cell.head === -1) {
      cell.head = index;
      return;
    }
    if (depth >= MAX_DEPTH) {
      this.nextIndex[index] = cell.head;
      cell.head = index;
      return;
    }
    cell.leaf = false;
    let occupant = cell.head;
    cell.head = -1;
    while (occupant !== -1) {
      const following = this.nextIndex[occupant] ?? -1;
      this.nextIndex[occupant] = -1;
      const occupantNode = this.nodes[occupant];
      if (occupantNode !== undefined) {
        this.insertInto(
          this.childFor(cell, occupantNode.x, occupantNode.y),
          occupant,
          occupantNode.x,
          occupantNode.y,
          depth + 1,
        );
      }
      occupant = following;
    }
    this.insertInto(this.childFor(cell, x, y), index, x, y, depth + 1);
  }

  private childFor(cell: QuadCell, x: number, y: number): QuadCell {
    const east = x >= cell.centerX;
    const south = y >= cell.centerY;
    const quarter = cell.halfExtent / 2;
    if (south) {
      if (east) {
        if (cell.southEast === null) {
          cell.southEast = new QuadCell(cell.centerX + quarter, cell.centerY + quarter, quarter);
        }
        return cell.southEast;
      }
      if (cell.southWest === null) {
        cell.southWest = new QuadCell(cell.centerX - quarter, cell.centerY + quarter, quarter);
      }
      return cell.southWest;
    }
    if (east) {
      if (cell.northEast === null) {
        cell.northEast = new QuadCell(cell.centerX + quarter, cell.centerY - quarter, quarter);
      }
      return cell.northEast;
    }
    if (cell.northWest === null) {
      cell.northWest = new QuadCell(cell.centerX - quarter, cell.centerY - quarter, quarter);
    }
    return cell.northWest;
  }

  private computeCellMass(cell: QuadCell): void {
    let mass = 0;
    let weightedX = 0;
    let weightedY = 0;
    if (cell.leaf) {
      for (let index = cell.head; index !== -1; index = this.nextIndex[index] ?? -1) {
        const node = this.nodes[index];
        if (node === undefined) continue;
        const nodeMass = effectiveMass(node);
        mass += nodeMass;
        weightedX += nodeMass * node.x;
        weightedY += nodeMass * node.y;
      }
    } else {
      const children = [cell.northWest, cell.northEast, cell.southWest, cell.southEast];
      for (const child of children) {
        if (child === null || child === undefined) continue;
        this.computeCellMass(child);
        mass += child.mass;
        weightedX += child.mass * child.centerOfMassX;
        weightedY += child.mass * child.centerOfMassY;
      }
    }
    cell.mass = mass;
    cell.centerOfMassX = mass > 0 ? weightedX / mass : cell.centerX;
    cell.centerOfMassY = mass > 0 ? weightedY / mass : cell.centerY;
  }

  private accumulateFromCell(
    cell: QuadCell,
    node: SimNode,
    nodeIndex: number,
    theta: number,
    repulsion: number,
    out: ForceAccumulator,
  ): void {
    if (cell.mass <= 0) return;
    if (cell.leaf) {
      for (let index = cell.head; index !== -1; index = this.nextIndex[index] ?? -1) {
        if (index === nodeIndex) continue;
        const other = this.nodes[index];
        if (other === undefined) continue;
        addPairForce(node, effectiveMass(other), other.x, other.y, repulsion, out);
      }
      return;
    }
    const deltaX = node.x - cell.centerOfMassX;
    const deltaY = node.y - cell.centerOfMassY;
    const distanceSquared = deltaX * deltaX + deltaY * deltaY;
    const size = cell.halfExtent * 2;
    // s/d < theta, compared squared to avoid the sqrt; with theta = 0 this is
    // never satisfied, so the traversal degrades to exact all-pairs.
    if (size * size < theta * theta * distanceSquared) {
      addPairForce(node, cell.mass, cell.centerOfMassX, cell.centerOfMassY, repulsion, out);
      return;
    }
    if (cell.northWest !== null) this.accumulateFromCell(cell.northWest, node, nodeIndex, theta, repulsion, out);
    if (cell.northEast !== null) this.accumulateFromCell(cell.northEast, node, nodeIndex, theta, repulsion, out);
    if (cell.southWest !== null) this.accumulateFromCell(cell.southWest, node, nodeIndex, theta, repulsion, out);
    if (cell.southEast !== null) this.accumulateFromCell(cell.southEast, node, nodeIndex, theta, repulsion, out);
  }
}

export function buildQuadTree(nodes: SimNode[]): QuadTree {
  separateCoincidentNodes(nodes);
  const tree = new QuadTree(nodes);
  for (let index = 0; index < nodes.length; index++) {
    tree.insert(index);
  }
  tree.computeMass();
  return tree;
}
