// The CV matching vocabulary (extracted from `cvParse.ts`, #1816).
//
// WHY IT IS ITS OWN FILE
//   `cvParse.ts` imports `mammoth` and `pdf-parse` at module scope, so nothing
//   that runs outside Next can import it — including `scripts/test/`, which
//   loads modules directly under Node's type stripping. The starter vocabulary
//   (`skillSeed.ts`) is required to cover every term in this list, and that
//   assertion was being made against a HAND-COPIED duplicate of the list in
//   the test file: the copy could go stale in either direction and the test
//   would keep passing while claiming coverage it no longer had. So the list
//   lives here, dependency-free, and both the parser and the test read the one
//   array.
//
//   `cvParse.ts` re-exports it, so `SKILL_VOCABULARY` keeps its old import
//   path.
//
// A pragmatic vocabulary of common tech/role skills. Matching against a known
// list keeps precision high (no free-text guessing). Extend as needed — and
// when you do, `npm run test:skill-vocabulary` fails until `skillSeed.ts`
// resolves the new term.
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
