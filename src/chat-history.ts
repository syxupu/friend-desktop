import type { ChatMessage } from './types';

/** Keep local notices between the same surviving Tavern messages when history refreshes. */
export function mergeChatHistory(history: ChatMessage[], previous: ChatMessage[]): ChatMessage[] {
  const positions = new Map(history.map((message, index) => [message.id, index]));
  const buckets = Array.from({ length: history.length + 1 }, () => [] as ChatMessage[]);
  const nextPositions: (number | undefined)[] = new Array(previous.length);
  let next: number | undefined;
  for (let index = previous.length - 1; index >= 0; index--) {
    const message = previous[index];
    if (message.role !== 'notice' && positions.has(message.id)) next = positions.get(message.id);
    nextPositions[index] = next;
  }
  let preceding: number | undefined, conversationCount = 0, sinceAnchor = 0;
  for (let index = 0; index < previous.length; index++) {
    const message = previous[index];
    if (message.role !== 'notice') {
      conversationCount++;
      if (positions.has(message.id)) { preceding = positions.get(message.id); sinceAnchor = 0; }
      else sinceAnchor++;
      continue;
    }
    // Newly generated messages receive their canonical IDs after completion.
    // With no surviving anchor, their prior conversation position is the fallback.
    const fallback = preceding === undefined ? conversationCount : preceding + 1 + sinceAnchor;
    const position = nextPositions[index] ?? Math.min(fallback, history.length);
    buckets[position].push(message);
  }
  return history.flatMap((message, index) => [...buckets[index], message]).concat(buckets[history.length]);
}
