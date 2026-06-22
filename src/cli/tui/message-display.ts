export function nextStaticMessageCount({
  messagesLength,
  previousStaticMessageCount,
  streaming,
}: {
  messagesLength: number;
  previousStaticMessageCount: number;
  streaming: boolean;
}): number {
  if (messagesLength < previousStaticMessageCount) return 0;

  const maxStaticCount = Math.max(0, messagesLength - 1);
  if (streaming) {
    return Math.min(previousStaticMessageCount, maxStaticCount);
  }

  return maxStaticCount;
}
