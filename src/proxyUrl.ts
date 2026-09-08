/**
 * 已配入游戏的音频（规范游戏相对路径，如 audio/hit.wav 或 assets/audio/x.mp3）的播放地址。
 * manifest 不保留下载链接，只能由 host 读本地文件返回。
 */
export function gameAudioUrl(slug: string, file: string): string {
  return `/api/wb/bgm/game-audio?slug=${encodeURIComponent(slug)}&file=${encodeURIComponent(file)}`;
}
