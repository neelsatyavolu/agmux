/** Detect whether a string contains characters from complex scripts whose
 *  rendering requires OpenType shaping (consonant + vowel-sign clusters,
 *  bidirectional layout, etc.). xterm.js's Canvas renderer draws on a
 *  monospace grid and does not invoke shaping, so these scripts render
 *  with misaligned combining marks in PTY mode. The SDK chat view uses
 *  the browser's text layout engine and renders them correctly. */
export function containsComplexScript(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.codePointAt(i);
    if (cp === undefined) continue;
    if (
      // Devanagari, Bengali, Gurmukhi, Gujarati, Oriya
      (cp >= 0x0900 && cp <= 0x0bff) ||
      // Tamil
      (cp >= 0x0b80 && cp <= 0x0bff) ||
      // Telugu, Kannada, Malayalam, Sinhala
      (cp >= 0x0c00 && cp <= 0x0dff) ||
      // Thai, Lao, Tibetan, Myanmar
      (cp >= 0x0e00 && cp <= 0x109f) ||
      // Hebrew
      (cp >= 0x0590 && cp <= 0x05ff) ||
      // Arabic, Arabic Supplement
      (cp >= 0x0600 && cp <= 0x06ff) ||
      (cp >= 0x0750 && cp <= 0x077f) ||
      // Khmer
      (cp >= 0x1780 && cp <= 0x17ff)
    ) {
      return true;
    }
    // Skip the low surrogate of a surrogate pair so we don't double-count.
    if (cp > 0xffff) i += 1;
  }
  return false;
}
