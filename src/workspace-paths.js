/**
 * picturereader workspace-visible paths (workspace-paths.js)
 *
 * Where a tool writes its output by default, and why a path the agent has just
 * written can be reported missing.
 *
 * The plugin runs inside the DSH host process, but the agent normally produces
 * the images it hands to these tools from a *shell command*, and that shell runs
 * inside the DSH file sandbox. On Linux the workspace-write sandbox is built as
 * `--ro-bind / / --tmpfs /tmp --bind <workspace> <workspace>`: the whole
 * filesystem is read-only except the session workspace, and `/tmp` is replaced
 * by a **fresh, empty tmpfs that is discarded when the command exits**.
 *
 * Both directions of that split are traps, and this module is the one place that
 * knows about them:
 *
 * * a file the agent writes to `/tmp` from a shell command does not exist for
 *   this process, which sees the host's own `/tmp` - a different directory tree
 *   under the same name. Every image tool would then answer "file not found"
 *   about a file the agent can prove it created, so {@link missingFileHint}
 *   explains exactly that case instead of leaving a bare message;
 * * the reverse holds too: output this plugin writes to the OS temp dir is
 *   invisible to the agent's shell, cannot be read by a later shell command and
 *   cannot be delivered as a file. {@link defaultOutputDir} therefore defaults to
 *   a scratch directory **inside the session workspace**
 *   (`<cwd>/.picturereader/<kind>/<session>`), which both sides can see; the OS
 *   temp dir stays the fallback for a call with no session cwd at all.
 *
 * @module picturereader/workspace-paths
 */

import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** Scratch directory the plugin uses inside the session workspace. */
export const SCRATCH_DIR = '.picturereader';

/** Resolve the OS temp dir at call time (a host or a test may set TMPDIR). */
function tempRoot() {
  return resolve(tmpdir());
}

/**
 * Resolve the default directory a tool writes into.
 *
 * `kind` groups outputs by tool ("doc", "edit", "crop") and `stamp` (the session
 * id) keeps two sessions sharing one workspace apart. With a session cwd the
 * result is `<cwd>/.picturereader/<kind>/<stamp>`: inside the tree the sandbox
 * mounts read-write, so the agent's shell, the next tool call and DSH's own
 * file tools all see it. Without a cwd the OS temp dir is used, which is still
 * correct for an output only ever read back by another picturereader call.
 *
 * Nothing is created here - the caller makes the directory when it writes.
 *
 * @param {string} kind - tool family, used as the subdirectory name.
 * @param {{cwd?: string, stamp?: string}} [opts] - session cwd and session id.
 * @returns {string} absolute directory path.
 */
export function defaultOutputDir(kind, opts = {}) {
  const cwd = opts.cwd === undefined || opts.cwd === null ? '' : String(opts.cwd).trim();
  const rawStamp = opts.stamp === undefined || opts.stamp === null ? '' : String(opts.stamp).trim();
  const stamp = rawStamp === '' ? 'anon' : rawStamp;
  if (cwd !== '') {
    return join(resolve(cwd), SCRATCH_DIR, kind, stamp);
  }
  return join(tempRoot(), `picturereader-${kind}`, stamp);
}

/**
 * Explain a path that resolved to nothing, when the sandbox is the reason.
 *
 * Returns an empty string for every ordinary missing file, so callers can append
 * the result to their message unconditionally. A path under the OS temp dir gets
 * the explanation, because that is the one place where "not found" is almost
 * never a mistake about the name: the file exists, in the sandbox's own mount
 * namespace.
 *
 * Only absolute local paths are judged: an `FsTarget.displayPath` may be
 * workspace-relative or a remote URI, and neither can be a sandbox tmpfs.
 *
 * @param {string} path - the path (a displayPath) that was not found.
 * @returns {string} a message suffix, or ''.
 */
export function missingFileHint(path) {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return '';
  const root = tempRoot();
  const p = resolve(path);
  if (p !== root && !p.startsWith(root + sep)) return '';
  return `\nThe path is under the system temp directory (${root}), which inside the DSH file sandbox is a private tmpfs discarded when the shell command that created it exits: this process sees a different ${root}. Write the file into the session workspace instead (for example ${SCRATCH_DIR}/...) and pass that path.`;
}
