import type {ContentPart} from '../core/types.js';
import type { InboundMessage } from '../core/types.js';
import type { MemoryStore, MessageRow } from '../memory/store.js';
import type { OneBotAction } from '../onebot/action.js';
import type { TurnContext } from './turn.js';
import { hasImages, isImageSegment, collectImagesFromHistory } from '../llm/vision.js';
import { collectVideoFrames, parseVideoSegments, MAX_VIDEOS_PER_TURN } from '../llm/video.js';
import {captureReplyWindow} from './window.js';
import {imageTokens} from '../context/tokens.js';
function imageCount(row: MessageRow): number {
  try {const segments=JSON.parse(row.raw_segments ?? '[]');return Array.isArray(segments)?segments.filter(isImageSegment).length:0;}catch{return 0;}
}
export interface ResolvedImages {
  images: Array<ContentPart & {type:'image'}>; notes: string[]; visionNote: string;
  sourceRowIds?: number[]; priorityRowIds?: number[];
}
/** Retain request/quoted pictures before ambient ones, then restore chronological ordering. */
export function fitImagesToBudget(result: ResolvedImages, tokenBudget: number): number {
  const priorities = new Set(result.priorityRowIds ?? []);
  const ranked = result.images.map((_,i)=>i).sort((a,b)=>
    Number(priorities.has(result.sourceRowIds?.[b] ?? 0))-Number(priorities.has(result.sourceRowIds?.[a] ?? 0)) || b-a);
  const keep: number[] = []; let remaining = Math.max(0, tokenBudget);
  for (const i of ranked) {
    const cost = imageTokens(result.images[i]!);
    if (cost <= remaining) {keep.push(i); remaining -= cost;}
  }
  keep.sort((a,b)=>a-b);
  const omitted = result.images.length-keep.length;
  result.images = keep.map(i=>result.images[i]!);
  result.notes = keep.map(i=>result.notes[i]!);
  result.sourceRowIds = keep.map(i=>result.sourceRowIds?.[i] ?? 0);
  return omitted;
}
export async function resolveImages(store: MemoryStore, msg: InboundMessage, _lookback: number, turn: TurnContext, api: OneBotAction): Promise<ResolvedImages> {
  const window=turn.replyWindow ?? captureReplyWindow(store,turn);
  const priorityRowIds=new Set(turn.mergedMessageRowIds ?? [turn.triggerMessageRowId]);
  const byId=new Map(window.rows.filter(row=>imageCount(row)>0).map(row=>[row.id,row]));
  // Explicit quotes can revisit an older image, but only inside this conversation.
  for(const segment of msg.segments.filter(seg=>seg.type==='reply')){
    const reference=Number(segment.data['id']);if(!Number.isFinite(reference)||reference===0)continue;
    const row=store.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND message_id=? AND id<=? ORDER BY id DESC LIMIT 1')
      .get(turn.conversationId,reference,turn.historyCutoffId) as unknown as MessageRow|undefined;
    if(row&&imageCount(row)>0){byId.set(row.id,row);priorityRowIds.add(row.id);}
  }
  // A queued requester may precede the last completed reply; its own images still belong to this request.
  if(hasImages(msg.segments))for(const id of turn.mergedMessageRowIds ?? [turn.triggerMessageRowId]){
    const row=store.db.prepare('SELECT * FROM messages WHERE id=? AND conversation_id=? AND id<=?')
      .get(id,turn.conversationId,turn.historyCutoffId) as unknown as MessageRow|undefined;
    if(row&&imageCount(row)>0)byId.set(row.id,row);
  }
  const rows=[...byId.values()].sort((a,b)=>Number(priorityRowIds.has(a.id))-Number(priorityRowIds.has(b.id)) || a.id-b.id);
  const total=rows.reduce((n,row)=>n+imageCount(row),0);
  const hist = await collectImagesFromHistory(rows.map(row => ({ rawSegments: row.raw_segments, senderName: row.sender_name,
    createdAt: row.created_at, rowId: row.id, userId: row.user_id, messageId: row.message_id ?? undefined })), Math.min(total,32), {
    ...turn.config.media, signal: turn.signal, getImage: file => api.getImage(file, { timeoutMs: turn.config.media.timeoutMs }),
    onSourceImage: (image, index, source) => {
      if (turn.signal.aborted || !store.getConversation(turn.conversationId)) return;
      const { part: _part, ...metadata } = image;
      store.db.prepare('INSERT OR REPLACE INTO media_sources (hash,conversation_id,source_row_id,sender_id,message_id,image_index,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(image.hash!, turn.conversationId, source.rowId!, source.userId!, source.messageId ?? null, index, JSON.stringify(metadata), source.createdAt);
    },
  });
  // ---- 视频：抽帧后按图片处理（历史窗口里的视频也一并覆盖）----
  const videoNotes: string[] = [];
  const videoRows = window.rows
    .map(row => ({ row, segs: parseVideoSegments(row.raw_segments) }))
    .filter(x => x.segs.length > 0)
    .slice(-MAX_VIDEOS_PER_TURN);
  if (videoRows.length > 0) {
    const frames = await collectVideoFrames(
      videoRows.flatMap(x => x.segs),
      {
        ...turn.config.media, signal: turn.signal, senderLabel: videoRows[0]!.row.sender_name,
        getImage: file => api.getImage(file, { timeoutMs: turn.config.media.timeoutMs }),
      },
    );
    const rowId = videoRows[0]!.row.id;
    for (let i = 0; i < frames.images.length; i++) {
      hist.images.push(frames.images[i]!.part);
      hist.notes.push(frames.notes[i] ?? '视频帧');
      hist.sourceRowIds?.push(rowId);
    }
    videoNotes.push(...frames.errors);
    if (frames.images.length > 0) {
      videoNotes.push(`视频只抽了 ${frames.images.length} 帧，只代表片段，别当成完整剧情。`);
    }
  }

  // Collection prioritizes requested sources; model input returns to chronological order.
  const order=hist.images.map((_,i)=>i).sort((a,b)=>(hist.sourceRowIds?.[a] ?? 0)-(hist.sourceRowIds?.[b] ?? 0));
  hist.images=order.map(i=>hist.images[i]!); hist.notes=order.map(i=>hist.notes[i]!);
  hist.sourceRowIds=order.map(i=>hist.sourceRowIds?.[i] ?? 0);
  const omitted=Math.max(0,total-32);
  const issues=[...hist.errors.slice(0,3),...videoNotes,...(omitted?[`窗口共有${total}张图片，资源限制下${omitted}张未读取，不能推测未读取图片。`]:[])];
  return { images: hist.images, notes: hist.notes, sourceRowIds: hist.sourceRowIds, priorityRowIds: [...priorityRowIds], visionNote: issues.join('\n') };
}
