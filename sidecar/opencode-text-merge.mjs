function commonPrefixLength(left, right) {
  let i = 0;
  while (i < left.length && i < right.length && left[i] === right[i]) i += 1;
  return i;
}

function suffixPrefixOverlap(text, delta) {
  const max = Math.min(text.length, delta.length);
  for (let len = max; len > 0; len -= 1) {
    if (text.endsWith(delta.slice(0, len))) return len;
  }
  return 0;
}

function resolveLatest(previous, next) {
  if (previous && previous.length > next.length && previous.startsWith(next)) {
    return previous;
  }
  return next;
}

export function mergeAssistantText(previousText, nextText) {
  const latestText = resolveLatest(previousText, nextText);
  const prev = previousText ?? '';
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(prev, latestText)),
  };
}

export function appendAssistantTextDelta(previousText, delta) {
  const deltaToEmit = delta.slice(suffixPrefixOverlap(previousText, delta));
  return {
    nextText: previousText + deltaToEmit,
    deltaToEmit,
  };
}
