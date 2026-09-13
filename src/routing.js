/**
 * picturereader 三模式路由 (routing.js)
 *
 * 用户在设置卡里选择一个使用模式，控制"什么时候走外部 VLM API、什么时候
 * 只用本地工具、要不要交叉验证"。这把语义集中在这里，供各工具 / 图片桥 /
 * vision_analyze 共享，保证行为一致：
 *
 * - privacy（隐私）：无论是否配置了外部 API 一律不调用。所有路线只走本地
 *   （image_scan / image_ocr / image_sample）。硬 gate，绝不外呼。
 * - smart（智能）：让 LLM 先简单看图（image_scan），再自己选是走外部 API、
 *   自己看细节、还是 OCR，目标是减少调用轮数与耗时。
 * - strict（严谨）：LLM 自行选择路线，在必要时交叉验证（多证据对照），
 *   可以仔细查看细节。
 *
 * @module picturereader/routing
 */

/** 三模式取值。 */
export const MODES = Object.freeze({
  privacy: 'privacy',
  smart: 'smart',
  strict: 'strict',
});

/**
 * Human-readable mode labels.
 *
 * There used to be a Chinese variant as well; the project is English-only now,
 * so this single table is the only source of mode names (settings card,
 * bridge hints, tool output).
 */
export const MODE_LABELS = Object.freeze({
  privacy: 'Privacy',
  smart: 'Smart',
  strict: 'Strict',
});

/** 合法模式集合。 */
export const MODE_KEYS = Object.freeze(Object.keys(MODES));

/** 归一化任意输入为一个合法模式值；非法值回退默认 'smart'。 */
export function normalizeMode(raw) {
  const v = String(raw ?? '').trim();
  return MODE_KEYS.includes(v) ? v : MODES.smart;
}

/**
 * 某模式下是否允许调用外部 VLM / 任何网络视觉 API。
 * 隐私模式为硬门禁：即使配置了外部 API 也不调用。
 * @param {string} mode - 归一化后的模式。
 * @returns {boolean} true=允许外呼（smart/strict），false=禁用（privacy）。
 */
export function vlmAllowed(mode) {
  return normalizeMode(mode) !== MODES.privacy;
}

/**
 * 隐私模式下即使配置了外部 API 也要强制本地——这是对 vision_analyze /
 * 图片桥的硬约束说明。
 */
export function isPrivacy(mode) {
  return normalizeMode(mode) === MODES.privacy;
}

/**
 * 某模式下 vision_analyze 的推荐证据默认。
 * @param {string} mode
 * @returns {{includeScan:boolean, includeOcr:boolean, includeVlm:boolean, allowLowInfo:boolean}}
 */
export function visionAnalyzeDefaults(mode) {
  const m = normalizeMode(mode);
  if (m === MODES.privacy) {
    // 隐私：本地证据为主，VLM 永远归零。
    return { includeScan: true, includeOcr: true, includeVlm: false, allowLowInfo: false };
  }
  if (m === MODES.smart) {
    // 智能：先 scan，OCR 按需，能调外部 VLM（省轮数靠"值得才调"引导）。
    return { includeScan: true, includeOcr: false, includeVlm: true, allowLowInfo: false };
  }
  // strict：全证据 + 允许多看细节，必要时交叉验证。
  return { includeScan: true, includeOcr: true, includeVlm: true, allowLowInfo: false };
}

/**
 * 把模式策略转成给纯文本 LLM 的中文行为引导（用于图片桥 hint、也用于
 * vision_analyze 的描述构成，让模型据此决定路线）。
 * @param {string} mode - 归一化后的模式。
 * @param {{vlmConfigured: boolean}} [opts]
 * @returns {string} 一段给模型的行为说明。
 */
export function routePolicyText(mode, opts = {}) {
  const m = normalizeMode(mode);
  const vlmConfigured = opts.vlmConfigured === undefined ? true : !!opts.vlmConfigured;
  if (m === MODES.privacy) {
    return (
      '[Mode: Privacy] Never call any external vision API and never reach the network for model help. ' +
      'For every image you may only use local tools: image_scan (layout / colors / structure), ' +
      'image_ocr (read text), image_sample (close-up material and texture). ' +
      'Understand the image yourself with these local tools.'
    );
  }
  if (m === MODES.smart) {
    return (
      '[Mode: Smart] Start with image_scan for a quick look at the image (layout / colors / whether it contains text / whether it is a photo). ' +
      'Then decide for yourself: ' +
      '(1) if the image is mostly text, image_ocr is enough — no need to call a VLM; ' +
      '(2) if it is an ordinary chart, UI or simple content, image_scan + image_sample are enough — no need to call a VLM; ' +
      '(3) only when the content is genuinely complex and needs semantic understanding (a photo, an abstract scene) ' +
      (vlmConfigured
        ? 'and it is worth the cost, call vision_analyze(include_vlm=true) to reach the external VLM'
        : 'would a VLM help, but no external VLM is configured here, so stay local') +
      '. The goal is fewer round trips and less wall time: prefer local work whenever it suffices.'
    );
  }
  return (
    '[Mode: Strict] Choose the route yourself and optimise for reliability: start with image_scan for the overall picture, ' +
    'then use image_ocr for text and image_sample for close detail when needed. Cross-check the key conclusions: ' +
    'compare the image_scan / image_ocr ( / external VLM) evidence against each other instead of trusting a single source. ' +
    (vlmConfigured
      ? 'When semantic understanding is needed and worth it, use vision_analyze(include_vlm=true). '
      : 'No external VLM is configured, so prefer local tools. ') +
    'Look at details closely, but avoid hallucination and give a grounded description.'
  );
}

/**
 * 渲染一条批量/桥接时用的简短模式说明（首行），供 hint 复用。
 * @param {string} mode
 * @returns {string}
 */
export function routeModeTag(mode) {
  const m = normalizeMode(mode);
  return `[mode:${MODE_LABELS[m]}]`;
}
