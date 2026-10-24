/**
 * 视频理解：把消息里的视频抽成几帧，当成图片喂给视觉模型。
 *
 * 为什么走「抽帧 + 现有图片链路」而不是专门接一个视频模型：
 *  - 视觉模型本来就是按图理解画面，抽 4 帧足够回答「这是什么 / 在干什么 / 画面里有什么字」
 *  - 复用现有的图片预算、OCR、历史窗口逻辑，不用再造一条并行的多模态通路
 *  - 成本可控：一段视频只多 4 张图，比整个视频上传便宜一个量级
 *
 * 依赖宿主机有 ffmpeg/ffprobe。没有时不要报错崩掉聊天，退化成文字说明。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorDetails, getLogger } from '../core/logger.js';
import type { ObMessageSegment } from '../core/types.js';
import { readSource, type MediaOptions } from './media.js';
import type { CollectedImage } from './vision.js';

/** 一轮最多处理几个视频（多了 token 和耗时都吃不消） */
export const MAX_VIDEOS_PER_TURN = 1;
/** 每个视频抽几帧 */
export const FRAMES_PER_VIDEO = 4;
/** 视频下载上限 */
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

const FFMPEG = process.env.QQ_AGENT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.QQ_AGENT_FFPROBE || 'ffprobe';
/** 借容器 ffmpeg 时用的容器名 */
const CONTAINER = process.env.QQ_AGENT_NAPCAT_CONTAINER || 'napcat';

type Mode = 'local' | 'docker' | 'error';

export function isVideoSegment(seg: ObMessageSegment): boolean {
  if (seg.type !== 'video') return false;
  const d = (seg.data ?? {}) as Record<string, unknown>;
  return Boolean(d['url'] || d['file'] || d['path']);
}

export function hasVideo(segments: ObMessageSegment[]): boolean {
  return segments.some(isVideoSegment);
}

/** 从消息行里存下来的 raw_segments 里挑出视频段（历史消息也走这里） */
export function parseVideoSegments(rawSegments: string | null): ObMessageSegment[] {
  if (!rawSegments) return [];
  try {
    const parsed = JSON.parse(rawSegments) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as ObMessageSegment[]).filter(isVideoSegment);
  } catch {
    return [];
  }
}

interface RunResult {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
}

function run(cmd: string, args: string[], timeoutMs = 25000): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout: Buffer[] = [];
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, stdout: Buffer.alloc(0), stderr: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      resolve({ ok: false, stdout: Buffer.alloc(0), stderr: '超时' });
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => stdout.push(b));
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString().slice(0, 500);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: Buffer.alloc(0), stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: Buffer.concat(stdout), stderr });
    });
  });
}

async function probeDuration(file: string, mode: Mode): Promise<number> {
  const r = mode === 'docker'
    ? await run('docker', ['exec', CONTAINER, 'ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 15000)
    : await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 15000);
  if (!r.ok) return 0;
  const n = Number(r.stdout.toString().trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 按时间比例抽帧，返回 JPEG 字节数组 */
async function extractFrames(file: string, count: number, mode: Mode): Promise<Buffer[]> {
  const duration = await probeDuration(file, mode);
  const fractions = [0.06, 0.32, 0.6, 0.88];
  const frames: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const t = duration > 0 ? Math.max(0, Math.min(duration - 0.1, duration * fractions[i % fractions.length]!)) : i * 2;
    const args = [
      '-v', 'error',
      '-ss', t.toFixed(2),
      '-i', file,
      '-frames:v', '1',
      // 压到 720 宽：视觉模型够看，token 也省
      '-vf', "scale='min(720,iw)':-2",
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-',
    ];
    const r = mode === 'docker'
      ? await run('docker', ['exec', CONTAINER, 'ffmpeg', ...args], 40000)
      : await run(FFMPEG, args, 25000);
    if (r.ok && r.stdout.length > 1024) frames.push(r.stdout);
  }
  return frames;
}

/**
 * 选谁来跑 ffmpeg。
 *  - local：宿主机装了 ffmpeg（本机 Windows、装过的服务器）
 *  - docker：宿主机没有，但 NapCat 容器里有 —— 用 `docker cp` 送进去跑，
 *    帧从 stdout 拿回来。国内服务器装 ffmpeg 很麻烦，这条路零下载。
 */
let cachedMode: Mode | null = null;

async function resolveMode(): Promise<Mode> {
  const forced = (process.env.QQ_AGENT_FFMPEG_MODE || '').toLowerCase();
  if (forced === 'docker' || forced === 'local') return forced as Mode;
  if (cachedMode) return cachedMode;
  const local = await run(FFMPEG, ['-version'], 3000);
  if (local.ok) {
    cachedMode = 'local';
    return 'local';
  }
  const dockered = await run('docker', ['exec', CONTAINER, 'ffmpeg', '-version'], 6000);
  if (dockered.ok) {
    cachedMode = 'docker';
    getLogger('video').info({ container: CONTAINER }, '宿主机没有 ffmpeg，改用容器内的 ffmpeg 抽帧');
    return 'docker';
  }
  cachedMode = 'error';
  return 'error';
}

export interface VideoFramesResult {
  images: CollectedImage[];
  notes: string[];
  errors: string[];
}

/**
 * 把视频段抽成帧。失败只记 errors，不抛异常 —— 主流程退化成「收到一个视频」。
 */
export async function collectVideoFrames(
  segments: ObMessageSegment[],
  opts: MediaOptions & { senderLabel?: string } = {},
): Promise<VideoFramesResult> {
  const images: CollectedImage[] = [];
  const notes: string[] = [];
  const errors: string[] = [];
  const videos = segments.filter(isVideoSegment).slice(0, MAX_VIDEOS_PER_TURN);
  if (videos.length === 0) return { images, notes, errors };

  for (let vi = 0; vi < videos.length; vi++) {
    const seg = videos[vi]!;
    const d = (seg.data ?? {}) as Record<string, unknown>;
    const file = String(d['file'] ?? d['path'] ?? '');
    const url = String(d['url'] ?? '');
    const label = opts.senderLabel ? `${opts.senderLabel} 发的视频` : '视频';
    let temp = '';
    try {
      let bytes: Buffer | null = null;
      try {
        bytes = await readSource(url || file, { ...opts, maxBytes: MAX_VIDEO_BYTES });
      } catch {
        bytes = null;
      }
      // 老实现只给 file 名不给 url 时，借 OneBot 的 get_image 换一个可下地址
      if (!bytes && opts.getImage && file) {
        try {
          const recovered = await opts.getImage(file);
          for (const source of [recovered.url, recovered.file].filter(Boolean) as string[]) {
            try {
              bytes = await readSource(source, { ...opts, maxBytes: MAX_VIDEO_BYTES });
              break;
            } catch {
              /* 继续试下一个 */
            }
          }
        } catch {
          /* 拿不到就算了，下面统一报错 */
        }
      }
      if (!bytes || !bytes.length) throw new Error('视频为空或地址不可用');
      const key = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      temp = path.join(os.tmpdir(), `qqagent-video-${key}.mp4`);
      await fs.writeFile(temp, bytes);

      const mode = await resolveMode();
      if (mode === 'error') {
        errors.push(`视频抽帧不可用（${label}）：宿主机和容器里都找不到 ffmpeg`);
        continue;
      }
      let framePath = temp;
      let inContainer = '';
      if (mode === 'docker') {
        inContainer = `/tmp/qqagent-video-${key}.mp4`;
        const cp = await run('docker', ['cp', temp, `${CONTAINER}:${inContainer}`], 30000);
        if (!cp.ok) throw new Error(`docker cp 失败：${cp.stderr.slice(0, 120)}`);
        framePath = inContainer;
      }
      const frames = await extractFrames(framePath, FRAMES_PER_VIDEO, mode);
      if (inContainer) {
        await run('docker', ['exec', CONTAINER, 'rm', '-f', inContainer], 10000);
      }
      if (frames.length === 0) {
        errors.push(`视频抽帧失败（${label}）：ffmpeg 没吐画面`);
        getLogger('video').warn({ phase: 'extract', temp, url: Boolean(url) }, '视频抽帧失败');
        continue;
      }
      for (let i = 0; i < frames.length; i++) {
        images.push({
          part: { type: 'image', mimeType: 'image/jpeg', data: frames[i]!.toString('base64') },
          source: 'video',
          bytes: frames[i]!.length,
        });
        notes.push(`【${label} 第 ${i + 1}/${frames.length} 帧】`);
      }
    } catch (error) {
      errors.push(`视频读取失败（${label}）：${(error as Error).message}`);
      getLogger('video').warn({ phase: 'collect', url: Boolean(url), ...errorDetails(error) }, '视频读取/抽帧失败');
    } finally {
      if (temp) await fs.unlink(temp).catch(() => undefined);
    }
  }
  return { images, notes, errors };
}
