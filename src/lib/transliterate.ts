// Transliterate Turkish (and common accented) letters to ASCII so generated
// emails/usernames/slugs stay valid. NFD-stripping alone drops the dotless ı
// (it has no combining mark), so map the Turkish letters explicitly first.
const MAP: Record<string, string> = {
  ı: 'i', İ: 'I', ş: 's', Ş: 'S', ğ: 'g', Ğ: 'G',
  ü: 'u', Ü: 'U', ö: 'o', Ö: 'O', ç: 'c', Ç: 'C',
};

export function transliterate(input: string): string {
  return input
    .replace(/[ıİşŞğĞüÜöÖçÇ]/g, (ch) => MAP[ch] ?? ch)
    // Decompose remaining accents (é → e, etc.) and strip combining marks.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// A dotted email/username slug: transliterate, lowercase, non-alphanumerics → '.'.
export function slugify(input: string): string {
  return transliterate(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');
}
