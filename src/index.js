/**
 * picturereader — pixel-to-text image reading for text-only DeepSeek Harness
 * models.
 *
 * One plugin row registers a full local image-understanding toolset plus an
 * optional external vision API bridge, governed by the user's chosen usage
 * mode（设置页"图片阅读"卡片）：
 *
 *  - 隐私模式（privacy）：绝不调用外部 API，全走本地工具。
 *  - 智能模式（smart）：先简单看图再决定是否外呼，省轮数/时间。
 *  - 严谨模式（strict）：自行选择 + 必要时交叉验证细节。
 *
 * Tools registered:
 *  image_scan / image_ocr / image_sample      — 本地像素理解（原有）
 *  image_crop / image_palette / image_compare — 本地工具链扩充
 *  image_batch                                — 批量规模/上下文验证
 *  vision_analyze                             — 统一图像理解（按模式路由）
 *  document_to_image                          — 文档(pdf/word/excel/ppt)转图片
 *
 * Settings: the plugin's profile entry (`picturereader`) carries the exported
 * `Config` schema, so DSH's settings service exposes it and client.js registers
 * the "Picture Reader" card in the Web settings page. Every editable field is
 * volatile, so mode / VLM endpoint changes hot-apply without a host restart.
 *
 * @module picturereader
 */

import { createImageScanTool, createImageOcrTool, createImageSampleTool } from './tool.js';
import { createVisionAnalyzeTool } from './vision-analyze.js';
import { registerMoreTools } from './more-tools.js';
import { createImageBatchTool } from './image-batch.js';
import { createDocumentToImageTool } from './doc-tools.js';
import { createImageEditTool } from './image-edit.js';
import { readConfig } from './config.js';
import z from '@deepseek-ai/schemastery';
import { setRuntimeSource, getRuntimeConfig } from './runtime.js';
import { attachImageBridge } from './bridge.js';
import { registerTwinAdapters, refreshTwinAdapters } from './picturereader-vision.mjs';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { dshHome } from './paths.js';

/**
 * Absolute path of the scanned-text-models cache (`$DSH_HOME/picturereader-models.json`).
 *
 * Resolved through {@link dshHome} **at call time** rather than at module load,
 * so the rule stated in `src/paths.js` holds here too: a changed DSH_HOME is
 * observed without restarting DSH.
 *
 * @returns {string} absolute path (the file may not exist yet).
 */
function modelsCachePath() {
  return join(dshHome(), 'picturereader-models.json');
}

/**
 * Built-in skill: `image-reading`.
 *
 * The canonical text lives in `skills/image-reading.md` (shipped inside the
 * package) so the documentation and the skill can never drift apart. The
 * inline constant below is only a fallback for a trimmed installation where
 * that file is unavailable.
 */
const IMAGE_READING_SKILL_FILE = new URL('../skills/image-reading.md', import.meta.url);

const IMAGE_READING_SKILL_FALLBACK = `# Reading images (image-reading)

Goal: **see an image the way a multimodal model would and describe it
coherently**, with every conclusion traceable and verifiable.

## Workflow

1. **Global tone.** Run image_scan over the whole image with the default
   parameters. Read \`hue families\` first (the true color mix, unaffected by
   darkness), then \`structure\`, \`texture\` and \`regions\`.
2. **Find the subject.** Zoom into suspicious areas with \`px_per_cell\`
   (8-12 for outlines, 4-6 for structure, 2-3 for fine detail). Read the
   resulting shapes: head + shoulders + torso is a person, arc plus symmetric
   shading is a cylinder or sphere, and so on. A low-contrast subject can hide
   in the background, so always verify before concluding.
3. **Verify text.** For anything that looks like text, labels or UI, run
   image_ocr on that region (use region/focus to narrow it down). OCR reads
   actual characters and outranks any guess about what the text says.
4. **Judge material.** Use image_sample for an 8x8 pixel sample of a small
   area: smooth gradients read as sky, skin or water; high-contrast stripes as
   metal or wood grain.
5. **Synthesize.** Produce a coherent description (scene, subject, lighting,
   detail) and label each conclusion as measured (backed by pixel/OCR/sample
   data) or inferred (a structural guess, phrased as "looks like").

## Principles

1. **Grade the evidence.** Mark every conclusion measured or inferred, and
   state the basis for an inference.
2. **Prefer numbers.** Support descriptions with concrete metrics rather than
   vague adjectives.
3. **Global before local.** Tone first, then zoom in to verify; do not skip a
   step.
4. **Doubt means verify.** For any subject you might have missed, zoom, sample
   or OCR before concluding.
5. **Never invent.** Say when you are unsure; a model's description is not
   evidence on its own.
`;

/**
 * Load the built-in skill definition, reading the Markdown file when present.
 * @returns {{name:string, description:string, content:string}}
 */
function imageReadingSkill() {
  let content = IMAGE_READING_SKILL_FALLBACK;
  try {
    const raw = readFileSync(IMAGE_READING_SKILL_FILE, 'utf8');
    const withoutFrontMatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    if (withoutFrontMatter.trim() !== '') content = withoutFrontMatter.trim();
  } catch {
    // Package trimmed or file unreadable: fall back to the inline copy.
  }
  return {
    name: 'image-reading',
    description:
      'Read and understand images like a multimodal model using the picturereader tools ' +
      '(image_scan / image_ocr / image_sample). Applies a verified five-step workflow ' +
      '(global tone -> find subjects -> verify text -> judge material -> synthesize) ' +
      'guided by grounded principles. Use whenever you need to look at an image.',
    content,
  };
}

export const name = 'picturereader';

/**
 * Mark one Config field as live-editable.
 *
 * `.volatile()` arrived in `@deepseek-ai/schemastery` 3.18.4, the version DSH
 * 0.1.7 ships; the plugin's own dev checkout can still resolve an older copy,
 * where the method does not exist. There the field stays plain instead of
 * crashing the import — such a host simply exposes no live fields.
 *
 * @template T
 * @param {T} field - schemastery field.
 * @returns {T} the same field, volatile when the builder supports it.
 */
function live(field) {
  return typeof field?.volatile === 'function' ? field.volatile() : field;
}

/**
 * Runtime schema of the plugin's profile entry (schemastery).
 *
 * Exported, and every editable field is live (`live()`): on DSH 0.1.7 the
 * Loader exposes a plugin entry's schema to the settings service through
 * `fiber.runtime.Config`, and only volatile fields are editable and applied
 * live (non-volatile ones are absent from the form, and a write to them is
 * refused with "is not volatile"). The namespace is the row's own entry id
 * (`picturereader`), which is also the key the browser half reads
 * (`ConfigForms.get`).
 *
 * Because volatile fields arrive as `Volatile<T>` references, `apply()` hands
 * the resolved object to the rest of the plugin through `readConfig()`.
 */
export const Config = z.object({
  mode: live(z
    .string()
    .default('smart')
    .description('Operating mode: privacy / smart / strict')),
  vlm_enabled: live(z
    .boolean()
    .default(false)
    .description('Optional: enable the external vision API. Until this is checked no external endpoint is ever called and everything stays local.')),
  vision_bridge_enabled: z
    .boolean()
    .default(false)
    .description('(Deprecated — use vision_models instead.)'),
  vision_models: live(z
    .array(z.object({
      id: z.string(),
      provider: z.string().default(''),
      note: z.string().default(''),
    }))
    .default([])
    .description('Vision bridge models: each checked text model gets a "(vision)" variant.')),
  vlm_base: live(z
    .string()
    .default('')
    .description('OpenAI-compatible vision endpoint URL (e.g. https://api.openai.com/v1; empty disables the external VLM).')),
  vlm_model: live(z.string().default('gpt-4o-mini').description('Vision model name.')),
  vlm_key: live(z.string().default('').role('secret').description('Vision API key (write-only; never read back or displayed).')),
  vlm_key_env: live(z
    .string()
    .default('')
    .description('Environment variable to fall back to when vlm_key is empty (e.g. VISUAL_API_KEY).')),
  vlm_timeout_ms: live(z
    .number()
    .default(300000)
    .description('Advanced: external vision request timeout in milliseconds.')),
  vlm_max_tokens: live(z
    .number()
    .default(8192)
    .description('Advanced: maximum output tokens for the external vision call.')),
  bridge_export_dir: live(z
    .string()
    .default('')
    .description('Advanced: image bridge export directory (empty = system temp directory).')),
  max_image_bytes: live(z
    .number()
    .default(52428800)
    .description('Advanced: maximum size of a single image in bytes (default 50 MB).')),
  scan_default_size: live(z
    .number()
    .default(32)
    .description('Advanced: default image_scan grid size (8..64).')),
  scan_palette: live(z
    .string()
    .default('auto')
    .description('Advanced: default image_scan palette (auto/full/basic/gray).')),
  scan_mode: live(z
    .string()
    .default('auto')
    .description('Advanced: default image_scan mode (auto/ascii/color).')),
  ocr_language: live(z
    .string()
    .default('')
    .description('Advanced: default OCR language as a BCP-47 tag, which selects the PaddleOCR recognition model. ' +
      'Empty (or "auto") keeps the two-model default that ocr_priority orders. Another script needs its own tag ' +
      '(ru for Russian, de for German, ar for Arabic, ...). A tag pins a single model and so switches ocr_priority off.')),
  ocr_priority: live(z
    .string()
    .default('')
    .description('Advanced: model order for the two-model OCR default. "auto" or "zh" reads the CJK model first ' +
      '(better for a Chinese reader), "cyrillic" reads the East Slavic model first (better for a Russian reader). ' +
      'Both models still run; the order only decides which one wins when they disagree. ' +
      'Only used while the OCR language is left at its two-model default.')),
  multimodal_models: live(z
    .string()
    .default('')
    .description('Advanced: multimodal allowlist (comma separated). These models receive images directly without degradation.')),
  request_guard: live(z
    .boolean()
    .default(true)
    .description('Advanced: request guard — last-resort image block degradation on llm/stream.')),
  batch_probe_first: live(z
    .number()
    .default(3)
    .description('Advanced: image_batch probes this many leading images to decide whether the batch is text-dense.')),
  batch_ocr_limit_chars: live(z
    .number()
    .default(800)
    .description('Advanced: per-image OCR excerpt length in image_batch.')),
  doc_dpi: live(z
    .number()
    .default(150)
    .description('Advanced: document_to_image render DPI (72..300).')),
  doc_max_pages: live(z
    .number()
    .default(50)
    .description('Advanced: document_to_image maximum page count (1..500).')),
  debug: live(z
    .boolean()
    .default(false)
    .description('Advanced: debug logging.')),
});

/** Services required at runtime. */
export const inject = ['tools', 'fs', 'llm', 'attachments'];

export function apply(ctx, config) {
  // 内核 0.1.2 起 settings-controller 的 describe() 原生枚举全部注册命名空间
  // （rc.2 时代 dsh-host-apiproxy 的 WEB_SETTINGS_NAMESPACES 白名单连同整个
  // apiproxy 包已被移除），本补丁退役；调用已删除（原 ensureSettingsNamespaceExposed）。
  // ── 运行时快照：工具执行时惰性读最新 mode / VLM 配置 ──
  // The Loader owns the entry config and updates volatile fields in place, so
  // every read resolves the current values; nothing here is cached.
  const getConfig = () => readConfig(config);
  setRuntimeSource(getConfig);

  // ── 注册工具（不需要 settings/llm 服务）──
  ctx.effect(() => {
    ctx.tools.register(createImageScanTool(ctx));
    ctx.tools.register(createImageOcrTool(ctx));
    ctx.tools.register(createImageSampleTool(ctx));
    ctx.tools.register(createVisionAnalyzeTool(ctx));
    registerMoreTools(ctx);
    ctx.tools.register(createImageBatchTool(ctx));
    ctx.tools.register(createDocumentToImageTool(ctx));
    ctx.tools.register(createImageEditTool(ctx));
  });

  // ── 注册内置技能（image-reading）──
  try {
    if (ctx.skills && typeof ctx.skills.register === 'function') {
      ctx.effect(() => {
        return ctx.skills.register(imageReadingSkill());
      }, 'picturereader: image-reading skill');
      console.log('[picturereader] registered image-reading skill');
    }
  } catch (error) {
    ctx.logger?.warn?.(`[picturereader] skill registration failed: ${String(error)}`);
  }

  // ── 注册模型列表 API 路由（供 client 设置卡读取扫描结果）──
  try {
    ctx.inject(['webServer'], (sctx) => {
      const webServer = sctx.webServer;
      if (!webServer || typeof webServer.register !== 'function') return;
      const handler = async (req, res) => {
        try {
          const cachePath = modelsCachePath();
          const data = await readFile(cachePath, 'utf-8');
          if (getRuntimeConfig()?.debug) console.log('[picturereader] models route: read', data.length, 'bytes from', cachePath);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(data);
        } catch (err) {
          console.log('[picturereader] models route: read failed:', String(err));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
        }
      };
      ctx.effect(() => webServer.register({ kind: 'exact', path: '/picturereader/models', handler }), 'picturereader: models route');
    });
  } catch {}

  // ── 图片桥：等 attachments 服务就绪后再注册（读图需要它）──
  try {
    ctx.inject(['attachments'], (sctx) => {
      attachImageBridge(ctx);
    });
  } catch (error) {
    ctx.logger?.warn?.(`[picturereader] image bridge disabled: ${String(error)}`);
  }

  // ── 抑制自动生成页面：本插件自带设置卡片（settings.section）──
  // The settings service generates a generic page for every entry that carries
  // a Config schema; this plugin ships its own card, so the generated one would
  // duplicate every control. `configure` only changes presentation — the
  // namespace stays served, which is what ConfigForms.get reads.
  try {
    ctx.inject(['settings'], (sctx) => {
      if (typeof sctx.settings?.configure === 'function') {
        sctx.settings.configure({ auto: false }, ctx.fiber);
      }
    });
  } catch (error) {
    ctx.logger?.warn?.(`[picturereader] settings presentation not configured: ${String(error)}`);
  }

  // ── 模型扫描 + 视觉孪生路由（llm 已在顶层 inject 中声明）──
  ctx.inject(['llm'], (sctx) => {
    const llm = sctx.llm;
    // DSH 0.1.7 removed the settings service's `register()`: a plugin's profile
    // entry carries its own exported `Config` schema, and a settings save
    // updates the volatile fields in place and publishes
    // `loader/volatile-update`. Re-wrap the twin adapters on that event so a
    // newly checked model gains its "(vision)" variant without a host restart.
    ctx.on('loader/volatile-update', () => {
      try {
        refreshTwinAdapters(ctx, llm, getConfig);
      } catch (error) {
        ctx.logger?.warn?.(`[picturereader] twin refresh failed: ${String(error?.message || error)}`);
      }
    });

    // ── 扫描所有 provider 的文本模型 → 写入 available_text_models ──
    (async () => {
      try {
        if (!llm || typeof llm.listProviders !== 'function') {
          return;
        }
        const providers = llm.listProviders();
        const textModels = [];
        for (const p of providers) {
          try {
            const models = await llm.listModels(p.id);
            for (const m of models) {
              const mods = m.inputModalities || [];
              if (!mods.includes('image')) {
                textModels.push({ provider: p.id, id: m.id, name: m.name || m.id });
              }
            }
          } catch { /* 跳过 */ }
        }
        // 兜底：把用户已勾选的模型并入列表（即使某 provider 的模型扫描漏了，
        // 只要在 vision_models 里就应显示+打钩，与孪生保持一致）。
        try {
          const cfg = getConfig();
          const vms = Array.isArray(cfg?.vision_models) ? cfg.vision_models : [];
          for (const entry of vms) {
            const id = typeof entry === 'string' ? entry : entry?.id;
            const provider = typeof entry === 'object' ? (entry?.provider || '') : '';
            if (!id) continue;
            const exists = textModels.some((t) => t.provider === provider && t.id === id);
            if (!exists) textModels.push({ provider, id, name: id });
          }
        } catch { /* 兜底失败忽略 */ }
        if (textModels.length > 0) {
          await mkdir(join(modelsCachePath(), '..'), { recursive: true });
          await writeFile(modelsCachePath(), JSON.stringify(textModels, null, 2));
        }
      } catch {
        // 模型扫描失败静默
      }
    })();

    // ── 视觉孪生：包裹被勾选模型所属 provider 的 adapter，声明支持图片 + stream 拦截图片 ──
    try {
      registerTwinAdapters(ctx, llm, getConfig);
    } catch (e) {
      ctx.logger?.warn?.(`[picturereader] twin adapters failed: ${String(e?.message || e)}`);
    }
  });
}
