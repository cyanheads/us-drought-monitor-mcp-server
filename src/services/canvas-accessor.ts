/**
 * @fileoverview Startup-owned accessor for the optional analytical engine.
 * @module services/canvas-accessor
 */
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let canvas: DataCanvas | undefined;
/** Bind the framework-owned canvas once during setup. */
export function setCanvas(value: DataCanvas | undefined): void {
  canvas = value;
}
/** Read the configured analytical engine without creating one. */
export function getCanvas(): DataCanvas | undefined {
  return canvas;
}
