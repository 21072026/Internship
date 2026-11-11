// Text the standard 14 PDF fonts can draw (#1857; certificates #3319).
// pdf-lib's StandardFonts are WinAnsi (cp1252) encoded and THROW on
// anything else — "WinAnsi cannot encode ı" — so a single Turkish name used
// to turn a certificate or offer-letter download into a 500.
//
// The fold, in order: a character WinAnsi carries is kept (ä ö ü ß ç é …);
// a letter with a diacritic is reduced to its base letter (ş→s, ğ→g, İ→I,
// č→c, ő→o); the few base letters Unicode does not decompose (ı, ł, đ, ø is
// already WinAnsi) are mapped by hand; anything else becomes "?". The PDF is
// the only place this applies — on screen the text keeps every character.
// Dependency-free: scripts/test/*.test.mjs imports it directly.

const NO_DECOMPOSITION: Record<string, string> = { 'ı': 'i', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ħ': 'h', 'Ħ': 'H' };
// WinAnsi (cp1252) beyond Latin-1: the printable characters in 0x80–0x9F.
const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

function winAnsi(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return code === 0x09 || code === 0x0a || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRA.has(ch);
}

export function pdfSafeText(text: string): string {
  let out = '';
  for (const ch of text) {
    if (winAnsi(ch)) {
      out += ch;
      continue;
    }
    if (NO_DECOMPOSITION[ch]) {
      out += NO_DECOMPOSITION[ch];
      continue;
    }
    const base = ch.normalize('NFD').replace(/\p{M}/gu, '');
    out += base && [...base].every(winAnsi) ? base : '?';
  }
  return out;
}
