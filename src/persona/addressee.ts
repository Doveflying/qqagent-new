import fs from 'node:fs';
import path from 'node:path';
import {PROJECT_ROOT} from '../config/loader.js';

/**
 * 关系模式：同一份人格，「对面是谁」可以在运行时切换。
 *
 * - owner（默认）：对面是用户本人，人格里的原作设定只借语气，不套剧情。
 * - sendai：进入原作模式，对面当仙台叶月。
 *
 * 模式存在 config/roleplay.json，不进版本库；人格 YAML 不动，
 * 所以 Obsidian 每 10 分钟的同步不会把它冲掉。
 */
export type AddresseeMode = 'owner' | 'sendai';

const MODES: readonly AddresseeMode[] = ['owner', 'sendai'];

export function roleplayFile(root: string = PROJECT_ROOT): string {
  return path.join(root, 'config', 'roleplay.json');
}

export function readAddresseeModes(root: string = PROJECT_ROOT): Record<string, AddresseeMode> {
  try {
    const doc = JSON.parse(fs.readFileSync(roleplayFile(root), 'utf8')) as Record<string, unknown>;
    const out: Record<string, AddresseeMode> = {};
    for (const [id, mode] of Object.entries(doc ?? {})) {
      if (typeof mode === 'string' && (MODES as readonly string[]).includes(mode)) out[id] = mode as AddresseeMode;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeAddresseeMode(personaId: string, mode: AddresseeMode, root: string = PROJECT_ROOT): void {
  if (!(MODES as readonly string[]).includes(mode)) throw new Error(`未知的关系模式：${mode}`);
  const all = readAddresseeModes(root);
  all[personaId] = mode;
  fs.mkdirSync(path.dirname(roleplayFile(root)), { recursive: true });
  fs.writeFileSync(roleplayFile(root), `${JSON.stringify(all, null, 2)}\n`, 'utf8');
}

/** 原作模式下追加到提示词的一段话；owner 模式不追加任何内容。 */
export const SENDAI_NOTE = [
  '当前处于原作模式：对话对面是仙台叶月，你是宫城志绪理。',
  '按原作的称呼和距离感说话，可以直接提到五千圆、契约、同班、放学后那两三个小时这类共同经历，不必解释背景。',
  '不要跳出角色，不要说自己是 AI。',
].join('\n');

export function addresseeBlock(personaId: string, root: string = PROJECT_ROOT): string {
  return readAddresseeModes(root)[personaId] === 'sendai' ? SENDAI_NOTE : '';
}
