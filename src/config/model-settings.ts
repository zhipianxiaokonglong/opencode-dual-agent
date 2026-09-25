/**
 * 模型设置（v1.1 §6）：全局默认 + 项目级覆盖 + 任务级覆盖。
 * 优先级：任务 > 项目 > 全局（§6.2）。
 * 模型列表来自 OpenCode 已配置 provider，本模块只做选择与持久化，不管理 API Key（§8.3）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { ModelRefSchema, type ModelRef } from "../protocols/ui-event";

export type ModelChannel = "planner" | "coder";

const ChannelSettingsSchema = z
  .object({
    default: z.string().nullable().default(null),
    projectOverrides: z.record(z.string()).default({}),
  })
  .strict();

const ModelSettingsFileSchema = z
  .object({
    models: z
      .object({
        planner: ChannelSettingsSchema,
        coder: ChannelSettingsSchema,
      })
      .strict(),
  })
  .strict();

export type ModelSettingsFile = z.infer<typeof ModelSettingsFileSchema>;

export const EMPTY_SETTINGS: ModelSettingsFile = {
  models: {
    planner: { default: null, projectOverrides: {} },
    coder: { default: null, projectOverrides: {} },
  },
};

/** "provider/model" → ModelRef；非法返回 null。 */
export function parseModelRef(spec: string | null | undefined): ModelRef | null {
  if (!spec) return null;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return null;
  const parsed = ModelRefSchema.safeParse({
    providerID: spec.slice(0, slash),
    id: spec.slice(slash + 1),
  });
  return parsed.success ? parsed.data : null;
}

export function formatModelRef(model: ModelRef): string {
  return `${model.providerID}/${model.id}`;
}

export class ModelSettings {
  private constructor(
    private readonly file: string | null,
    private data: ModelSettingsFile,
  ) {}

  static load(file: string): ModelSettings {
    let data = EMPTY_SETTINGS;
    try {
      const parsed = ModelSettingsFileSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (parsed.success) data = parsed.data;
    } catch {
      // 文件不存在或损坏时用默认值
    }
    return new ModelSettings(file, data);
  }

  static memory(initial: Partial<ModelSettingsFile> = {}): ModelSettings {
    return new ModelSettings(null, {
      models: {
        planner: { ...EMPTY_SETTINGS.models.planner, ...initial.models?.planner },
        coder: { ...EMPTY_SETTINGS.models.coder, ...initial.models?.coder },
      },
    });
  }

  /**
   * 解析生效模型：任务级 > 项目级 > 全局。
   * 返回 null 表示未配置（由调用方决定回退，如会话默认模型）。
   */
  resolve(channel: ModelChannel, projectDir?: string, taskOverride?: ModelRef | null): ModelRef | null {
    if (taskOverride) return taskOverride;
    const settings = this.data.models[channel];
    if (projectDir) {
      const key = normalizeDir(projectDir);
      const override = settings.projectOverrides[key] ?? settings.projectOverrides[projectDir];
      const parsed = parseModelRef(override);
      if (parsed) return parsed;
    }
    return parseModelRef(settings.default);
  }

  /** 返回所有解析出的默认/覆盖（UI 选择器展示用）。 */
  snapshot(): ModelSettingsFile {
    return structuredClone(this.data);
  }

  setDefault(channel: ModelChannel, model: ModelRef | null): void {
    this.data.models[channel].default = model ? formatModelRef(model) : null;
    this.persist();
  }

  setProjectOverride(channel: ModelChannel, projectDir: string, model: ModelRef | null): void {
    const key = normalizeDir(projectDir);
    if (model) this.data.models[channel].projectOverrides[key] = formatModelRef(model);
    else delete this.data.models[channel].projectOverrides[key];
    this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
  }
}

function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
