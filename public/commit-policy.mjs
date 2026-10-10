// Keep words in their spoken phrase; only split uninterrupted speech at a bounded ceiling.
export function shouldCommit({ speaking, speechStart, lastLoud, now }) {
  return speaking && ((now - speechStart >= 900 && now - lastLoud >= 650) || now - speechStart >= 12000);
}
