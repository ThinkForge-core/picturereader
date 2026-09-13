/**
 * Host capability profile (platform-profile.js)
 *
 * The plugin is Linux-only — this module is not about other desktop operating
 * systems. It answers a narrower question: **which optional features can
 * actually run on this host**, so that a Termux/Android device does not
 * advertise tools whose Python packages cannot be installed there.
 *
 * Termux uses Bionic libc, so PyPI's manylinux wheels do not apply and a
 * package without a Termux build would have to be compiled from source. The
 * plugin's own OCR and media environments therefore live inside a
 * `proot-distro` Debian rootfs (see scripts/termux/setup.sh). What remains
 * unavailable even there are the *optional* extras that the base environments
 * do not include, plus anything that needs an external binary.
 *
 * @module picturereader/platform-profile
 */

/**
 * Whether the DSH host is Termux.
 *
 * Detected from `PREFIX`, which Termux sets to its app-private prefix
 * (`/data/data/com.termux/files/usr`). Nothing else needs to be probed: when
 * DSH runs on the device, it inherits that variable.
 *
 * @param env - environment to inspect (defaults to `process.env`).
 * @returns true when running inside Termux.
 */
export function isTermux(env = process.env) {
  const prefix = env?.PREFIX;
  return typeof prefix === 'string' && prefix.includes('com.termux');
}

/**
 * `image_edit` actions that cannot work under Termux, with the reason.
 *
 * These are exactly the actions that need the optional extras (`rembg`,
 * `rawpy`) or an external binary (`realesrgan-ncnn-vulkan`). Everything else —
 * resizing, cropping, compositing, colour work, edge detection — is plain
 * Pillow and OpenCV and works fine.
 */
export const TERMUX_UNAVAILABLE_EDIT_ACTIONS = {
  remove_background: 'needs rembg, which Termux cannot install',
  raw_convert: 'needs rawpy/libraw, which Termux cannot install',
  upscale: 'needs the external realesrgan-ncnn-vulkan binary, which has no Termux build'
};

/**
 * The subset of `image_edit` actions this host can run.
 *
 * @param all - the full action list.
 * @param options - `{ termux }` to override detection (tests).
 * @returns a new array, in the original order.
 */
export function availableEditActions(all, { termux = isTermux() } = {}) {
  if (!termux) return [...all];
  return all.filter((action) => !(action in TERMUX_UNAVAILABLE_EDIT_ACTIONS));
}

/**
 * A sentence for a tool description explaining what this host leaves out, or
 * an empty string when nothing is withheld.
 *
 * @param options - `{ termux }` to override detection (tests).
 * @returns the note, ending in a period, or `''`.
 */
export function termuxEditNote({ termux = isTermux() } = {}) {
  if (!termux) return '';
  const names = Object.keys(TERMUX_UNAVAILABLE_EDIT_ACTIONS);
  return `On this Termux device the ${names.join(' / ')} actions are not offered, because they need ${Object.values(TERMUX_UNAVAILABLE_EDIT_ACTIONS).join('; ')}.`;
}
