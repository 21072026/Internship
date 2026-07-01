// CV parsing (EPIC B1) — local, no AI, no external calls.
//
// Extracts plain text from an uploaded CV (PDF/DOCX) and derives ONLY
// high-precision profile suggestions: contact links and skills matched against
// a known vocabulary. Biographical fields (name, city, university, dates) are
// deliberately NOT guessed — the spike (docs/research/cv-parsing.md) found
// layout-dependent parsing too noisy to be useful. Everything here is private
// to the server; suggestions are presented for review, never auto-applied.

import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export interface CvSuggestions {
  phone?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  skills: string[];
}

// A pragmatic vocabulary of common tech/role skills. Matching against a known
// list keeps precision high (no free-text guessing). Extend as needed.
export const SKILL_VOCABULARY: string[] = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'C#', 'C++', 'C', 'Go', 'Rust', 'Ruby', 'PHP', 'Kotlin', 'Swift', 'Scala',
  'React', 'Next.js', 'Vue', 'Angular', 'Svelte', 'Node.js', 'Express', 'Django', 'Flask', 'FastAPI', 'Spring', 'Spring Boot', '.NET', 'Laravel', 'Rails',
  'HTML', 'CSS', 'Tailwind', 'Sass', 'Redux', 'GraphQL', 'REST', 'tRPC',
  'SQL', 'MySQL', 'PostgreSQL', 'MariaDB', 'MongoDB', 'Redis', 'SQLite', 'Prisma', 'Elasticsearch',
  'Docker', 'Kubernetes', 'AWS', 'Azure', 'GCP', 'Terraform', 'Ansible', 'Linux', 'Nginx', 'CI/CD', 'Git', 'GitHub Actions',
  'TensorFlow', 'PyTorch', 'Pandas', 'NumPy', 'scikit-learn', 'Machine Learning', 'Data Science', 'NLP',
  'Figma', 'Jira', 'Agile', 'Scrum', 'Kanban',
  'English', 'German', 'Turkish', 'French', 'Spanish',
];

/** Extract plain text from a CV buffer based on its content type. */
export async function extractCvText(data: Buffer, contentType: string): Promise<string> {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('pdf')) {
    const parser = new PDFParse({ data });
    try {
      const res = await parser.getText();
      return res.text ?? '';
    } finally {
      await parser.destroy?.();
    }
  }
  if (ct.includes('word') || ct.includes('officedocument') || ct.includes('msword')) {
    const res = await mammoth.extractRawText({ buffer: data });
    return res.value ?? '';
  }
  return '';
}

function firstMatch(re: RegExp, text: string): string | undefined {
  const m = re.exec(text);
  return m ? m[0] : undefined;
}

/** Derive high-precision suggestions from extracted CV text. */
export function suggestFromText(text: string): CvSuggestions {
  const flat = text.replace(/ /g, ' ');

  // Phone: international or local, 9–15 digits with common separators.
  const phone = firstMatch(/(?:\+?\d[\d\s().-]{8,14}\d)/, flat.replace(/[A-Za-z@]/g, ' '))?.trim();

  // URLs by host.
  const urls = flat.match(/https?:\/\/[^\s)<>"']+/gi) ?? [];
  const bare = flat.match(/\b(?:www\.)?(?:linkedin\.com|github\.com)\/[^\s)<>"']+/gi) ?? [];
  const all = [...urls, ...bare.map((u) => (u.startsWith('http') ? u : `https://${u}`))];
  const clean = (u?: string) => u?.replace(/[.,;)]+$/, '');
  const linkedinUrl = clean(all.find((u) => /linkedin\.com/i.test(u)));
  const githubUrl = clean(all.find((u) => /github\.com/i.test(u)));
  const portfolioUrl = clean(all.find((u) => !/linkedin\.com|github\.com/i.test(u)));

  // Skills: word-boundary match against the vocabulary (case-insensitive),
  // preserving canonical casing. Escape regex metacharacters in terms.
  const skills: string[] = [];
  for (const term of SKILL_VOCABULARY) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^A-Za-z0-9+#.])${esc}(?:$|[^A-Za-z0-9+#.])`, 'i');
    if (re.test(flat)) skills.push(term);
  }

  return {
    ...(phone ? { phone } : {}),
    ...(linkedinUrl ? { linkedinUrl } : {}),
    ...(githubUrl ? { githubUrl } : {}),
    ...(portfolioUrl ? { portfolioUrl } : {}),
    skills,
  };
}
