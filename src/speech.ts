/** Conservative extraction: explicit quotes or <say> only; uncertain narration stays silent. */
export function extractSpeech(text: string): string {
  const cleaned = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').replace(/```[\s\S]*?```/g, '').replace(/<details[\s\S]*?<\/details>/gi, '');
  const marked = [...cleaned.matchAll(/<say>([\s\S]*?)<\/say>/gi)].map(m => m[1]);
  const quotes = [...cleaned.matchAll(/“([^”]+)”|「([^」]+)」|『([^』]+)』|"([^"\n]+)"/g)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]);
  const parts = marked.length ? marked : quotes;
  return parts.map(part => part.replace(/\*[^*]*\*/g, '').replace(/\([^)]*\)|（[^）]*）/g, '').replace(/<[^>]+>/g, '').replace(/[*_#]/g, '').trim()).filter(Boolean).join('\n');
}

export async function synthesize(settings: { mimoUrl: string; mimoKey: string; mimoModel: string; voice: string; voiceStyle: string }, text: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${settings.mimoUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${settings.mimoKey}`, 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ model: settings.mimoModel, stream: false, messages: [
      ...(settings.voiceStyle ? [{ role: 'user', content: settings.voiceStyle }] : []),
      { role: 'assistant', content: text },
    ], audio: { format: 'wav', voice: settings.voice } }),
  });
  if (!response.ok) throw new Error(`MiMo 合成失败（HTTP ${response.status}）`);
  const json = await response.json();
  const audio = json.choices?.[0]?.message?.audio?.data;
  if (typeof audio !== 'string' || !audio.length || audio.length > 40_000_000) throw new Error('MiMo 未返回可用的 WAV 音频');
  const bytes = Buffer.from(audio, 'base64');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('MiMo 返回的音频不是 WAV');
  return audio;
}
