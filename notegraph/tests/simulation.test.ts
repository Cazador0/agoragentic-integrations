import { describe, expect, it } from 'vitest';
import type { SimLink, SimNode } from '../src/shared/types';
import { ForceSimulation, seedPosition } from '../src/renderer/graph/simulation';
import { buildQuadTree } from '../src/renderer/graph/quadtree';

function makeNode(id: string, x: number, y: number, overrides: Partial<SimNode> = {}): SimNode {
  return { id, x, y, vx: 0, vy: 0, mass: 1, radius: 4, fixed: false, ...overrides };
}

function makeSeededNode(id: string, index: number, overrides: Partial<SimNode> = {}): SimNode {
  const position = seedPosition(id, index);
  return makeNode(id, position.x, position.y, overrides);
}

function makeLink(source: number, target: number, restLength = 90, strength = 1): SimLink {
  return { source, target, strength, restLength };
}

function nodeAt(nodes: SimNode[], index: number): SimNode {
  const node = nodes[index];
  if (node === undefined) throw new Error(`missing node at index ${index}`);
  return node;
}

function separation(a: SimNode, b: SimNode): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function runTicks(simulation: ForceSimulation, count: number): void {
  for (let i = 0; i < count; i++) simulation.tick();
}

describe('seedPosition', () => {
  it('is deterministic and distinct across 100 indices', () => {
    const positions: Array<{ x: number; y: number }> = [];
    for (let index = 0; index < 100; index++) {
      const id = `note-${index}.md`;
      const first = seedPosition(id, index);
      const second = seedPosition(id, index);
      expect(second.x).toBe(first.x);
      expect(second.y).toBe(first.y);
      expect(Number.isFinite(first.x)).toBe(true);
      expect(Number.isFinite(first.y)).toBe(true);
      positions.push(first);
    }
    for (let a = 0; a < positions.length; a++) {
      for (let b = a + 1; b < positions.length; b++) {
        const first = positions[a];
        const second = positions[b];
        if (first === undefined || second === undefined) throw new Error('missing position');
        expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeGreaterThan(1e-3);
      }
    }
  });

  it('perturbs by id so distinct graphs do not overlap identically', () => {
    const first = seedPosition('alpha.md', 7);
    const second = seedPosition('beta.md', 7);
    expect(first.x === second.x && first.y === second.y).toBe(false);
  });
});

describe('ForceSimulation', () => {
  it('converges two linked nodes to within 20% of restLength', () => {
    const restLength = 90;
    const nodes = [makeSeededNode('a.md', 0), makeSeededNode('b.md', 1)];
    const simulation = new ForceSimulation({ centerGravity: 0, alphaDecay: 0.008 });
    simulation.setGraph(nodes, [makeLink(0, 1, restLength)]);
    for (let i = 0; i < 2000 && !simulation.isSettled(); i++) simulation.tick();
    const distance = separation(nodeAt(nodes, 0), nodeAt(nodes, 1));
    expect(distance).toBeGreaterThan(restLength * 0.8);
    expect(distance).toBeLessThan(restLength * 1.2);
  });

  it('spreads a tight cluster of mutually-unlinked nodes apart', () => {
    const nodes = [makeNode('a', 0, 0), makeNode('b', 1, 0), makeNode('c', 0.5, 0.8)];
    const initialDistances = [
      separation(nodeAt(nodes, 0), nodeAt(nodes, 1)),
      separation(nodeAt(nodes, 0), nodeAt(nodes, 2)),
      separation(nodeAt(nodes, 1), nodeAt(nodes, 2)),
    ];
    const simulation = new ForceSimulation();
    simulation.setGraph(nodes, []);
    runTicks(simulation, 300);
    const finalDistances = [
      separation(nodeAt(nodes, 0), nodeAt(nodes, 1)),
      separation(nodeAt(nodes, 0), nodeAt(nodes, 2)),
      separation(nodeAt(nodes, 1), nodeAt(nodes, 2)),
    ];
    for (let pair = 0; pair < 3; pair++) {
      const initial = initialDistances[pair];
      const final = finalDistances[pair];
      if (initial === undefined || final === undefined) throw new Error('missing distance');
      expect(final).toBeGreaterThan(initial);
    }
  });

  it('keeps the centroid near the origin under center gravity', () => {
    const nodes: SimNode[] = [];
    for (let index = 0; index < 20; index++) {
      nodes.push(makeSeededNode(`note-${index}.md`, index));
    }
    const links: SimLink[] = [];
    for (let index = 0; index < 15; index++) {
      links.push(makeLink(index, index + 1));
    }
    links.push(makeLink(0, 10), makeLink(3, 17), makeLink(5, 19));
    const simulation = new ForceSimulation();
    simulation.setGraph(nodes, links);
    for (let tickIndex = 1; tickIndex <= 400; tickIndex++) {
      simulation.tick();
      if (tickIndex % 20 === 0) {
        let sumX = 0;
        let sumY = 0;
        for (const node of nodes) {
          sumX += node.x;
          sumY += node.y;
        }
        const centroidNorm = Math.hypot(sumX / nodes.length, sumY / nodes.length);
        expect(centroidNorm).toBeLessThan(100);
      }
    }
  });

  it('settles below alphaMin in bounded ticks and then tick() is a bit-identical no-op', () => {
    const nodes = [
      makeSeededNode('a.md', 0),
      makeSeededNode('b.md', 1),
      makeSeededNode('c.md', 2),
      makeSeededNode('d.md', 3),
    ];
    const simulation = new ForceSimulation();
    simulation.setGraph(nodes, [makeLink(0, 1), makeLink(1, 2), makeLink(2, 3)]);
    let ticks = 0;
    while (!simulation.isSettled() && ticks < 400) {
      simulation.tick();
      ticks++;
    }
    expect(ticks).toBeLessThan(400);
    expect(simulation.isSettled()).toBe(true);
    expect(simulation.alpha).toBeLessThan(simulation.options.alphaMin);

    const snapshot = nodes.map((node) => ({ x: node.x, y: node.y, vx: node.vx, vy: node.vy }));
    const alphaBefore = simulation.alpha;
    const returned = simulation.tick();
    expect(returned).toBe(alphaBefore);
    expect(simulation.alpha).toBe(alphaBefore);
    for (let index = 0; index < nodes.length; index++) {
      const node = nodeAt(nodes, index);
      const before = snapshot[index];
      if (before === undefined) throw new Error('missing snapshot');
      expect(node.x).toBe(before.x);
      expect(node.y).toBe(before.y);
      expect(node.vx).toBe(before.vx);
      expect(node.vy).toBe(before.vy);
    }
  });

  it('is deterministic: identical inputs give identical positions after 200 ticks', () => {
    function buildScenario(): { nodes: SimNode[]; links: SimLink[] } {
      const nodes: SimNode[] = [];
      for (let index = 0; index < 12; index++) {
        nodes.push(makeSeededNode(`node-${index}.md`, index, { mass: 1 + (index % 3) }));
      }
      const links: SimLink[] = [
        makeLink(0, 1),
        makeLink(1, 2),
        makeLink(2, 3),
        makeLink(3, 0),
        makeLink(4, 5, 60),
        makeLink(6, 7, 120, 0.5),
        makeLink(8, 9),
        makeLink(10, 11),
        makeLink(0, 6),
      ];
      return { nodes, links };
    }

    const first = buildScenario();
    const second = buildScenario();
    const simulationA = new ForceSimulation();
    const simulationB = new ForceSimulation();
    simulationA.setGraph(first.nodes, first.links);
    simulationB.setGraph(second.nodes, second.links);
    runTicks(simulationA, 200);
    runTicks(simulationB, 200);

    expect(simulationB.alpha).toBe(simulationA.alpha);
    for (let index = 0; index < first.nodes.length; index++) {
      const nodeA = nodeAt(first.nodes, index);
      const nodeB = nodeAt(second.nodes, index);
      expect(nodeB.x).toBe(nodeA.x);
      expect(nodeB.y).toBe(nodeA.y);
      expect(nodeB.vx).toBe(nodeA.vx);
      expect(nodeB.vy).toBe(nodeA.vy);
    }
  });

  it('never moves a fixed node while forces act on it', () => {
    const fixedNode = makeNode('fixed.md', 5, 7, { fixed: true });
    const freeNode = makeNode('free.md', 25, 7);
    const nodes = [fixedNode, freeNode];
    const simulation = new ForceSimulation();
    simulation.setGraph(nodes, [makeLink(0, 1, 90)]);
    runTicks(simulation, 150);
    expect(fixedNode.x).toBe(5);
    expect(fixedNode.y).toBe(7);
    expect(fixedNode.vx).toBe(0);
    expect(fixedNode.vy).toBe(0);
    expect(Math.hypot(freeNode.x - 25, freeNode.y - 7)).toBeGreaterThan(1);
  });

  it('drops links with out-of-range indices instead of failing', () => {
    const nodes = [makeSeededNode('a.md', 0), makeSeededNode('b.md', 1)];
    const simulation = new ForceSimulation();
    simulation.setGraph(nodes, [
      makeLink(0, 1),
      makeLink(0, 5),
      makeLink(-1, 1),
      makeLink(1, 1),
      { source: 0.5, target: 1, strength: 1, restLength: 90 },
    ]);
    expect(simulation.links).toHaveLength(1);
    runTicks(simulation, 50);
    for (const node of nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it('separates coincident nodes instead of producing NaN', () => {
    const nodes = [makeNode('a.md', 10, 10), makeNode('b.md', 10, 10), makeNode('c.md', 10, 10)];
    const simulation = new ForceSimulation();
    simulation.setGraph(nodes, []);
    runTicks(simulation, 50);
    for (const node of nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(Number.isFinite(node.vx)).toBe(true);
      expect(Number.isFinite(node.vy)).toBe(true);
    }
    expect(separation(nodeAt(nodes, 0), nodeAt(nodes, 1))).toBeGreaterThan(1e-3);
    expect(separation(nodeAt(nodes, 0), nodeAt(nodes, 2))).toBeGreaterThan(1e-3);
    expect(separation(nodeAt(nodes, 1), nodeAt(nodes, 2))).toBeGreaterThan(1e-3);
  });
});

describe('Barnes-Hut quadtree', () => {
  it('theta 0.5 repulsion is within 10% of exact for at least 90% of ~60 nodes', () => {
    const nodes: SimNode[] = [];
    for (let index = 0; index < 60; index++) {
      nodes.push(makeSeededNode(`bh-${index}.md`, index, { mass: 1 + (index % 5) * 0.5 }));
    }
    const tree = buildQuadTree(nodes);
    const repulsion = 1200;
    let accurate = 0;
    for (let index = 0; index < nodes.length; index++) {
      const exact = { fx: 0, fy: 0 };
      tree.accumulateForce(index, 0, repulsion, exact);
      const approximate = { fx: 0, fy: 0 };
      tree.accumulateForce(index, 0.5, repulsion, approximate);
      const exactMagnitude = Math.hypot(exact.fx, exact.fy);
      expect(exactMagnitude).toBeGreaterThan(0);
      const errorMagnitude = Math.hypot(approximate.fx - exact.fx, approximate.fy - exact.fy);
      if (errorMagnitude / exactMagnitude <= 0.1) accurate++;
    }
    expect(accurate).toBeGreaterThanOrEqual(54);
  });

  it('theta 0 matches brute-force pairwise forces', () => {
    const nodes: SimNode[] = [];
    for (let index = 0; index < 25; index++) {
      nodes.push(makeSeededNode(`exact-${index}.md`, index, { mass: 1 + (index % 4) * 0.25 }));
    }
    const tree = buildQuadTree(nodes);
    const repulsion = 500;
    const softening = 0.01;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodeAt(nodes, index);
      let expectedForceX = 0;
      let expectedForceY = 0;
      for (let otherIndex = 0; otherIndex < nodes.length; otherIndex++) {
        if (otherIndex === index) continue;
        const other = nodeAt(nodes, otherIndex);
        const deltaX = node.x - other.x;
        const deltaY = node.y - other.y;
        const softened = deltaX * deltaX + deltaY * deltaY + softening;
        const scale = (repulsion * node.mass * other.mass) / (softened * Math.sqrt(softened));
        expectedForceX += scale * deltaX;
        expectedForceY += scale * deltaY;
      }
      const out = { fx: 0, fy: 0 };
      tree.accumulateForce(index, 0, repulsion, out);
      expect(out.fx).toBeCloseTo(expectedForceX, 8);
      expect(out.fy).toBeCloseTo(expectedForceY, 8);
    }
  });
});
