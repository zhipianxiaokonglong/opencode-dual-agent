/**
 * 提示词加载与插值。提示词文件位于 prompts/，变量用 {{name}} 占位。
 * 提示词内容属于构建产物；仓库/模型输出内容永远只作为变量值注入。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface PromptSource {
  render(name: string, vars: Record<string, string>): string;
}

export class FilePromptSource implements PromptSource {
  readonly #dir: string;
  readonly #cache = new Map<string, string>();

  constructor(dir?: string) {
    this.#dir = dir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");
  }

  render(name: string, vars: Record<string, string>): string {
    let template = this.#cache.get(name);
    if (template === undefined) {
      template = fs.readFileSync(path.join(this.#dir, `${name}.md`), "utf8");
      this.#cache.set(name, template);
    }
    return interpolate(template, vars);
  }
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? "");
}
