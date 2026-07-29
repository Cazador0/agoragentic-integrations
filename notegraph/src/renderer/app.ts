/**
 * Renderer app shell: wires the toolbar DOM controls and the
 * window.notegraph bridge (or the browser demo fallback) to the GraphView.
 */

import type { GraphData, GraphFilter, GraphNode, VaultStats } from '../shared/types';
import { DEFAULT_GRAPH_FILTER } from '../shared/types';
import type { NotegraphBridge } from '../shared/ipc';
import { GraphView } from './graph/renderer';

const SEARCH_DEBOUNCE_MS = 150;

type ToggleFlag = 'showAttachments' | 'showUnresolved' | 'showTags' | 'showOrphans';

interface DemoPayload {
  graph: GraphData;
  stats: VaultStats;
}

function requireElement<T extends HTMLElement>(id: string, elementType: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof elementType)) {
    throw new Error(`notegraph: required element #${id} is missing or of the wrong type`);
  }
  return element;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseDemoPayload(payload: unknown): DemoPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { graph, stats } = payload as { graph?: unknown; stats?: unknown };
  if (typeof graph !== 'object' || graph === null) return null;
  const graphShape = graph as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(graphShape.nodes) || !Array.isArray(graphShape.edges)) return null;
  if (typeof stats !== 'object' || stats === null) return null;
  const statsShape = stats as {
    noteCount?: unknown;
    attachmentCount?: unknown;
    unresolvedCount?: unknown;
  };
  if (
    !isFiniteNumber(statsShape.noteCount) ||
    !isFiniteNumber(statsShape.attachmentCount) ||
    !isFiniteNumber(statsShape.unresolvedCount)
  ) {
    return null;
  }
  return { graph: graph as GraphData, stats: stats as VaultStats };
}

function nodeStatusText(node: GraphNode): string {
  return node.path ?? node.label;
}

function initialize(): void {
  const canvas = requireElement('graph-canvas', HTMLCanvasElement);
  const openVaultButton = requireElement('open-vault', HTMLButtonElement);
  const searchInput = requireElement('search', HTMLInputElement);
  const fitButton = requireElement('fit', HTMLButtonElement);
  const statsLine = requireElement('stats', HTMLElement);
  const statusLine = requireElement('status', HTMLElement);
  const toggleBindings: ReadonlyArray<[HTMLInputElement, ToggleFlag]> = [
    [requireElement('toggle-attachments', HTMLInputElement), 'showAttachments'],
    [requireElement('toggle-unresolved', HTMLInputElement), 'showUnresolved'],
    [requireElement('toggle-tags', HTMLInputElement), 'showTags'],
    [requireElement('toggle-orphans', HTMLInputElement), 'showOrphans'],
  ];

  const filter: GraphFilter = { ...DEFAULT_GRAPH_FILTER };
  let currentGraph: GraphData = { nodes: [], edges: [] };
  let currentStats: VaultStats | null = null;
  let persistentStatus = 'starting…';

  const renderStatus = (message: string): void => {
    statusLine.textContent = message;
  };
  // Persistent status survives hover; hover text is shown transiently on top.
  const setStatus = (message: string): void => {
    persistentStatus = message;
    renderStatus(message);
  };
  const renderStatsLine = (): void => {
    if (currentStats === null) {
      statsLine.textContent = '—';
      return;
    }
    statsLine.textContent =
      `${currentStats.noteCount} notes · ${currentStats.attachmentCount} attachments · ` +
      `${currentStats.unresolvedCount} unresolved · ${currentGraph.edges.length} edges`;
  };
  const trackAsync = (operation: Promise<void>): void => {
    operation.catch((error: unknown) => {
      console.error('notegraph:', error);
      setStatus(`error: ${describeError(error)}`);
    });
  };

  const view = new GraphView(canvas);
  view.events = {
    onNodeClick: (node) => {
      setStatus(nodeStatusText(node));
    },
    onNodeHover: (node) => {
      if (node === null) renderStatus(persistentStatus);
      else renderStatus(node.label);
    },
  };
  view.start();

  const applyGraph = (graph: GraphData): void => {
    currentGraph = graph;
    view.setData(graph);
    renderStatsLine();
  };
  const applyFilter = (): void => {
    view.setFilter({ ...filter });
  };

  for (const [checkbox, flag] of toggleBindings) {
    checkbox.checked = DEFAULT_GRAPH_FILTER[flag];
    checkbox.addEventListener('change', () => {
      filter[flag] = checkbox.checked;
      applyFilter();
    });
  }

  let searchDebounceHandle: number | undefined;
  searchInput.addEventListener('input', () => {
    if (searchDebounceHandle !== undefined) window.clearTimeout(searchDebounceHandle);
    searchDebounceHandle = window.setTimeout(() => {
      searchDebounceHandle = undefined;
      filter.query = searchInput.value;
      applyFilter();
    }, SEARCH_DEBOUNCE_MS);
  });

  fitButton.addEventListener('click', () => {
    view.zoomToFit();
  });

  const bridge: NotegraphBridge | undefined = window.notegraph;
  if (bridge !== undefined) {
    const refreshStats = async (): Promise<void> => {
      currentStats = await bridge.getStats();
      renderStatsLine();
    };

    openVaultButton.addEventListener('click', () => {
      trackAsync(
        (async () => {
          const vaultPath = await bridge.openVaultDialog();
          if (vaultPath === null) return;
          await bridge.openVault(vaultPath);
          setStatus(`vault: ${vaultPath}`);
          applyGraph(await bridge.getGraph());
          await refreshStats();
        })(),
      );
    });

    bridge.onVaultEvent((event) => {
      if (event.type === 'graph') {
        applyGraph(event.graph);
        trackAsync(refreshStats());
      } else if (event.type === 'ready') {
        setStatus(`vault ready — ${event.fileCount} files indexed`);
      }
    });

    trackAsync(
      (async () => {
        const stats = await bridge.getStats();
        if (stats === null) {
          setStatus('no vault open');
          return;
        }
        currentStats = stats;
        setStatus(`vault: ${stats.vaultPath}`);
        applyGraph(await bridge.getGraph());
      })(),
    );
  } else {
    openVaultButton.disabled = true;
    openVaultButton.title = 'Opening a vault requires the Electron app; showing read-only demo data';
    trackAsync(
      (async () => {
        setStatus('loading demo data…');
        let payload: unknown;
        try {
          const response = await fetch('./graph-data.json');
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} fetching graph-data.json`);
          }
          payload = await response.json();
        } catch (error) {
          console.warn('notegraph: demo data unavailable:', error);
          setStatus('no vault bridge and no demo data');
          return;
        }
        const demo = parseDemoPayload(payload);
        if (demo === null) {
          console.warn('notegraph: demo data has an unexpected shape');
          setStatus('no vault bridge and no demo data');
          return;
        }
        currentStats = demo.stats;
        applyGraph(demo.graph);
        setStatus('demo data (read-only)');
      })(),
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initialize();
  });
} else {
  initialize();
}
