// src/sense-types.js — shared shapes for OS senses.
//
// Kept in plain JS (not .d.ts) because Node's `node:` test runner is the
// only consumer right now and we want zero extra deps. The exported
// constants are documentation; no runtime check enforces them.

/**
 * A walkable window top edge, in scene coordinates (origin at the fly's
 * current display, y up). Mirrors Environment.swift's Ledge.
 * @typedef {Object} Ledge
 * @property {number} y     center-line y
 * @property {number} x0    left edge x (clipped to the display)
 * @property {number} x1    right edge x
 * @property {number} id    X11 window id or composite key
 */

/**
 * A window that appeared since the last poll.
 * @typedef {Object} NewWindow
 * @property {{x:number,y:number}} center
 * @property {number} size  max(width, height)
 */

/**
 * @typedef {Object} Display
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} PollResult
 * @property {Ledge[]} ledges
 * @property {NewWindow[]} newWindows
 */

/**
 * @typedef {Object} SenseBackend
 * @property {(display: Display) => PollResult} poll
 * @property {(x:number, y:number) => void}    tap
 * @property {boolean} isAvailable
 * @property {string}  name
 */

export const SENSE_KIND = Object.freeze({
  HEADLESS: 'headless',
  X11: 'x11',
  WAYLAND: 'wayland',
});
