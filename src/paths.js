/**
 * picturereader machine-local path resolution (paths.js)
 *
 * Single source of truth for everything that points outside the plugin:
 * Python interpreters of the helper venvs, model-cache directories and
 * helper binaries such as LibreOffice.
 *
 * Resolution order (first hit wins):
 *   1. an explicit environment variable, when the caller names one;
 *   2. the installer's state file `$DSH_HOME/picturereader/env.json`
 *      (written by `scripts/install.py`);
 *   3. the installer's default prefix `$DSH_HOME/picturereader/venvs/<role>`.
 *
 * Keeping the state file in the chain is what makes installation
 * reproducible: the DSH process does not need any environment plumbing to
 * find the environments `scripts/install.py` created.
 *
 * Every function reads the environment at call time (never at module load),
 * so tests and long-lived hosts observe edits immediately.
 *
 * @module picturereader/paths
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';

/** Name of the venv roles the installer can create. */
export const VENV_ROLES = ['media', 'paddle'];

/** Cache of the parsed state file, keyed by absolute path + mtime. */
let stateCache = { path: null, mtimeMs: -1, value: null };

/** Resolve `$DSH_HOME` (defaults to `~/.dsh`), at call time. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh');
}

/** Absolute path of the installer state file. */
export function statePath() {
  return join(dshHome(), 'picturereader', 'env.json');
}

/** Directory holding the venvs created by the installer. */
export function venvPrefix() {
  return join(dshHome(), 'picturereader', 'venvs');
}

/**
 * Read and parse the installer state file.
 *
 * Never throws: a missing, unreadable or malformed file simply yields `null`,
 * which makes the caller fall back to the platform default. The result is
 * cached by path + mtime, so repeated calls during one tool execution are free
 * while an edit by the installer is picked up without restarting DSH.
 *
 * @returns {object|null} the parsed state, or null when unusable.
 */
export function readState() {
  const path = statePath();
  let mtimeMs;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    stateCache = { path, mtimeMs: -1, value: null };
    return null;
  }
  if (stateCache.path === path && stateCache.mtimeMs === mtimeMs) return stateCache.value;
  let value = null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
  } catch {
    value = null;
  }
  stateCache = { path, mtimeMs, value };
  return value;
}

/** Drop the cached state (tests, and callers that just rewrote the file). */
export function resetStateCache() {
  stateCache = { path: null, mtimeMs: -1, value: null };
}

/**
 * Python interpreter of an installer-managed venv.
 *
 * @param {string} role - venv role, see {@link VENV_ROLES}.
 * @param {string} [envVar] - environment variable that overrides everything.
 * @returns {string} absolute path (not guaranteed to exist).
 */
export function venvPython(role, envVar) {
  if (envVar !== undefined) {
    const fromEnv = process.env[envVar];
    if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();
  }
  const state = readState();
  const recorded = state?.venvs?.[role];
  const recordedPath = typeof recorded === 'string' ? recorded : recorded?.python;
  if (typeof recordedPath === 'string' && recordedPath.trim() !== '') return recordedPath.trim();
  return join(venvPrefix(), role, 'bin', 'python');
}

/**
 * Interpreter of the shared `media` venv (document conversion + image editing).
 * @returns {string} absolute path.
 */
export function mediaPython() {
  return venvPython('media', 'DSH_MEDIA_PYTHON');
}

/**
 * Interpreter of the PaddleOCR venv.
 * @returns {string} absolute path.
 */
export function paddlePython() {
  return venvPython('paddle', 'DSH_PADDLE_PYTHON');
}

/**
 * Directory holding the PaddleOCR model cache.
 * @returns {string} absolute path.
 */
export function paddleCacheHome() {
  const fromEnv = process.env.DSH_PADDLE_CACHE;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();
  const fromState = readState()?.caches?.paddlex;
  if (typeof fromState === 'string' && fromState.trim() !== '') return fromState.trim();
  return join(homedir(), '.paddlex-cache');
}

/**
 * Locate an executable on `PATH`.
 * @param {string} command - executable name, e.g. `soffice`.
 * @param {string} [env] - environment to read `PATH` from.
 * @returns {string|null} absolute path, or null when not found.
 */
export function which(command, env = process.env) {
  const raw = env?.PATH;
  if (typeof raw !== 'string' || raw === '') return null;
  for (const dir of raw.split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Absolute locations LibreOffice commonly uses on Linux. */
const SOFFICE_FALLBACKS = [
  '/usr/bin/soffice',
  '/usr/bin/libreoffice',
  '/usr/local/bin/soffice',
  '/usr/lib/libreoffice/program/soffice',
  '/opt/libreoffice/program/soffice'
];

/**
 * Locate the LibreOffice `soffice` executable.
 * Order: `DSH_SOFFICE` -> state file -> `PATH` -> known Linux locations.
 * @returns {string|null} absolute path, or null when LibreOffice is absent.
 */
export function sofficePath() {
  const fromEnv = process.env.DSH_SOFFICE;
  if (fromEnv && fromEnv.trim() !== '' && existsSync(fromEnv.trim())) return fromEnv.trim();
  const fromState = readState()?.tools?.soffice;
  if (typeof fromState === 'string' && fromState.trim() !== '' && existsSync(fromState.trim())) {
    return fromState.trim();
  }
  const onPath = which('soffice') ?? which('libreoffice');
  if (onPath !== null) return onPath;
  for (const candidate of SOFFICE_FALLBACKS) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Human-readable hint pointing at the project installer. */
export function installHint() {
  return 'run `python3 scripts/install.py` from the plugin directory';
}
