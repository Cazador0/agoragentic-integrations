/**
 * Pointer + wheel input for the graph canvas: node drag, background pan,
 * zoom-to-cursor, click and hover picking. Attached by GraphView's
 * constructor; owns no rendering state of its own.
 */

import type { Camera, GraphNode, SimNode } from '../../shared/types';

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;

const CLICK_MOVEMENT_THRESHOLD_PX = 4;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const DRAG_REHEAT_ALPHA = 0.3;
const DRAG_RELEASE_REHEAT_ALPHA = 0.1;

/** The internal GraphView surface the controller drives. */
export interface ControllerHost {
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  pick(screenX: number, screenY: number): GraphNode | null;
  findSimNode(nodeId: string): SimNode | undefined;
  screenToWorld(screenX: number, screenY: number): { x: number; y: number };
  reheat(alpha: number): void;
  markDirty(): void;
  setHoveredNode(node: GraphNode | null): void;
  setDraggedNode(nodeId: string | null): void;
  notifyNodeClick(node: GraphNode): void;
  zoomToFit(): void;
}

export function attachController(host: ControllerHost): () => void {
  const canvas = host.canvas;
  const camera = host.camera;

  let gesture: 'none' | 'drag' | 'pan' = 'none';
  let activePointerId: number | null = null;
  let totalMovementPx = 0;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let pressedNode: GraphNode | null = null;
  let draggedSimNode: SimNode | null = null;
  let panCameraStartX = 0;
  let panCameraStartY = 0;
  let panPointerStartX = 0;
  let panPointerStartY = 0;

  canvas.style.cursor = 'grab';
  // Without this, touch pointers get hijacked by scroll/zoom gestures before
  // pointermove ever fires.
  canvas.style.touchAction = 'none';

  const updateIdleCursor = (overNode: boolean): void => {
    canvas.style.cursor = overNode ? 'pointer' : 'grab';
  };

  const handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || gesture !== 'none') return;
    const node = host.pick(event.offsetX, event.offsetY);
    activePointerId = event.pointerId;
    totalMovementPx = 0;
    lastPointerX = event.offsetX;
    lastPointerY = event.offsetY;
    pressedNode = node;
    if (node !== null) {
      gesture = 'drag';
      draggedSimNode = host.findSimNode(node.id) ?? null;
      if (draggedSimNode !== null) {
        draggedSimNode.fixed = true;
        draggedSimNode.vx = 0;
        draggedSimNode.vy = 0;
      }
      host.setDraggedNode(node.id);
    } else {
      gesture = 'pan';
      panCameraStartX = camera.x;
      panCameraStartY = camera.y;
      panPointerStartX = event.offsetX;
      panPointerStartY = event.offsetY;
      canvas.style.cursor = 'grabbing';
    }
    canvas.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (gesture !== 'none' && event.pointerId === activePointerId) {
      const deltaX = event.offsetX - lastPointerX;
      const deltaY = event.offsetY - lastPointerY;
      totalMovementPx += Math.hypot(deltaX, deltaY);
      lastPointerX = event.offsetX;
      lastPointerY = event.offsetY;
      if (gesture === 'drag') {
        if (draggedSimNode !== null) {
          const worldPoint = host.screenToWorld(event.offsetX, event.offsetY);
          draggedSimNode.x = worldPoint.x;
          draggedSimNode.y = worldPoint.y;
          draggedSimNode.vx = 0;
          draggedSimNode.vy = 0;
          host.reheat(DRAG_REHEAT_ALPHA);
          host.markDirty();
        }
      } else {
        const scale = camera.scale > 0 ? camera.scale : 1;
        camera.x = panCameraStartX - (event.offsetX - panPointerStartX) / scale;
        camera.y = panCameraStartY - (event.offsetY - panPointerStartY) / scale;
        host.markDirty();
      }
      return;
    }
    if (event.buttons === 0) {
      const node = host.pick(event.offsetX, event.offsetY);
      host.setHoveredNode(node);
      updateIdleCursor(node !== null);
    }
  };

  const endGesture = (event: PointerEvent, allowClick: boolean): void => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    if (gesture === 'drag') {
      if (draggedSimNode !== null) {
        draggedSimNode.fixed = false;
        host.reheat(DRAG_RELEASE_REHEAT_ALPHA);
        host.markDirty();
      }
      host.setDraggedNode(null);
      if (allowClick && pressedNode !== null && totalMovementPx < CLICK_MOVEMENT_THRESHOLD_PX) {
        host.notifyNodeClick(pressedNode);
      }
    }
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    gesture = 'none';
    activePointerId = null;
    pressedNode = null;
    draggedSimNode = null;
    const nodeUnderPointer = host.pick(event.offsetX, event.offsetY);
    host.setHoveredNode(nodeUnderPointer);
    updateIdleCursor(nodeUnderPointer !== null);
  };

  const handlePointerUp = (event: PointerEvent): void => {
    endGesture(event, true);
  };

  const handlePointerCancel = (event: PointerEvent): void => {
    endGesture(event, false);
  };

  const handlePointerLeave = (): void => {
    if (gesture === 'none') {
      host.setHoveredNode(null);
      canvas.style.cursor = 'grab';
    }
  };

  const handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const pointerX = event.offsetX;
    const pointerY = event.offsetY;
    const worldUnderPointer = host.screenToWorld(pointerX, pointerY);
    const nextScale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, camera.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY)),
    );
    camera.scale = nextScale;
    camera.x = worldUnderPointer.x - (pointerX - canvas.clientWidth / 2) / nextScale;
    camera.y = worldUnderPointer.y - (pointerY - canvas.clientHeight / 2) / nextScale;
    if (gesture === 'pan') {
      // Re-base the pan anchors, or the next pointermove replays them at the
      // new scale and teleports the viewport.
      panCameraStartX = camera.x;
      panCameraStartY = camera.y;
      panPointerStartX = lastPointerX;
      panPointerStartY = lastPointerY;
    }
    host.markDirty();
  };

  const handleDoubleClick = (event: MouseEvent): void => {
    if (host.pick(event.offsetX, event.offsetY) === null) {
      host.zoomToFit();
    }
  };

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerCancel);
  canvas.addEventListener('pointerleave', handlePointerLeave);
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('dblclick', handleDoubleClick);

  return () => {
    canvas.removeEventListener('pointerdown', handlePointerDown);
    canvas.removeEventListener('pointermove', handlePointerMove);
    canvas.removeEventListener('pointerup', handlePointerUp);
    canvas.removeEventListener('pointercancel', handlePointerCancel);
    canvas.removeEventListener('pointerleave', handlePointerLeave);
    canvas.removeEventListener('wheel', handleWheel);
    canvas.removeEventListener('dblclick', handleDoubleClick);
  };
}
