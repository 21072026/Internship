/**
 * The starter skill vocabulary (#1816) — canonical skills with EN/TR/DE
 * labels, the spellings people actually type, and near-neighbour links.
 *
 * WHY THIS SHIPS IN THE REPO
 *
 * Skills are free text today, so "React", "react", "ReactJS" and "React.js"
 * are four different skills and no filter over them can be right. The taxonomy
 * work (#1811) needs something to normalise *to*, and an empty taxonomy is a
 * worse experience than free text: the first mentee to open a picker that
 * offers nothing gives up and types a blob. So the vocabulary ships filled and
 * curated, the way `newsletterContent.ts` ships filled newsletter issues.
 *
 * WHAT THIS FILE IS NOT
 *
 * It is the vocabulary ONLY. Nothing here rewires a filter, writes a row or
 * migrates the free-text `User.skills` values — those are #1819/#1820, and the
 * `Skill`/`UserSkill` models of #1815 do not exist in `prisma/schema.prisma`
 * yet. Until they do, this module is the vocabulary's single source of truth
 * and the only thing that has to be right.
 *
 * HOUSE STYLE FOR AN ENTRY (follow it when you add one)
 *
 *   - `key` is forever. Aliases and adjacency point at it, and a backfill will
 *     one day write it into a column. It is lower-case ASCII with hyphens, and
 *     `check:skills` asserts `skillKey(key) === key` so a key is always a valid
 *     lookup token in its own right.
 *   - All three labels are mandatory and are what a user SEES. For a proper
 *     noun ("React", "Docker", "PostgreSQL") the same string in all three is
 *     correct, not a missing translation — the checker allows that on purpose.
 *   - Where the English term is what a Turkish or German practitioner actually
 *     writes ("Agile", "DevOps", "Data Science"), the label stays as it is and
 *     the honest local phrasing goes into `aliases`. Inventing "Çevik Yazılım
 *     Geliştirme Metodolojileri" as a label would put a string in the picker
 *     that nobody would ever type.
 *   - `aliases` are the spellings people actually type, in any language. They
 *     are lookup tokens, never displayed. The key and all three labels are
 *     ALREADY indexed, so an alias that folds to one of them is redundant and
 *     the checker rejects it — that is what keeps the list from growing noise.
 *   - `adjacent` is "close enough that a person who has one is worth showing
 *     for the other". It is an UNDIRECTED relation: `buildSkillIndex`
 *     symmetrises it, so writing an edge under one entry, under the other, or
 *     under both are all the same graph and none of them is wrong. (Of the 179
 *     edges below, 125 happen to be written from both ends and 54 from one —
 *     that difference carries no meaning, which is exactly why the index does
 *     not preserve it. Write it wherever it reads best; the unit test asserts
 *     the result is symmetric.) It is deliberately unweighted: the matcher
 *     (#1819) owns scoring, and a weight guessed here would be a number nobody
 *     measured. Competing tools (`aws` ↔ `azure`) count as near-neighbours;
 *     spoken languages have no neighbours at all, and an empty list is a valid
 *     answer.
 *   - AN UMBRELLA TERM IS AN ALIAS ONLY IF THIS VOCABULARY HOLDS NO COMPETING
 *     PRODUCT UNDER IT. "NoSQL" was an alias of `mongodb`, which is how a
 *     Redis or Elasticsearch engineer — both in this list, both NoSQL — gets
 *     tagged as a MongoDB engineer. When the umbrella has competitors here it
 *     belongs as its own entry (adjacent to each of them) or nowhere; when it
 *     has none in this vocabulary ("Version Control" → `git`,
 *     "Containerization" → `docker`) the alias is the honest answer and is
 *     kept. Resolving to a near-miss is worse than resolving to nothing: free
 *     text stays free text, a wrong key is a wrong claim on a CV.
 *
 * DEPENDENCY-FREE ON PURPOSE
 *
 * Same reason as `lastContactRule.ts` and `skills.ts`: `scripts/check-skills.mjs`
 * and the unit test load this file directly under Node's type stripping, which
 * resolves no `@/` alias. That is also why `buildSkillIndex` takes the fold as
 * an argument instead of importing `skillKey` — the caller passes the real one
 * (`src/lib/skillVocabulary.ts` does, and so does the checker), so there is no
 * second copy of the fold to drift.
 */

export type SkillLocale = 'en' | 'tr' | 'de';

export type SkillCategory =
  | 'role'
  | 'language'
  | 'frontend'
  | 'backend'
  | 'mobile'
  | 'database'
  | 'cloud'
  | 'infrastructure'
  | 'data'
  | 'design'
  | 'testing'
  | 'practice'
  | 'spoken';

export interface SkillEntry {
  /** Stable identifier. Lower-case ASCII + hyphens; never renamed. */
  key: string;
  labelEn: string;
  labelTr: string;
  labelDe: string;
  category: SkillCategory;
  /** Spellings people type. Lookup tokens only — never displayed. */
  aliases: readonly string[];
  /** Near-neighbour keys, authored one-way and symmetrised on load. */
  adjacent: readonly string[];
}

export interface SkillCategoryMeta {
  key: SkillCategory;
  labelEn: string;
  labelTr: string;
  labelDe: string;
}

/** Grouping for a picker; the order is the order a picker should show. */
export const SKILL_CATEGORIES: readonly SkillCategoryMeta[] = [
  { key: 'role', labelEn: 'Role & Focus', labelTr: 'Rol ve Odak', labelDe: 'Rolle & Schwerpunkt' },
  { key: 'language', labelEn: 'Programming Languages', labelTr: 'Programlama Dilleri', labelDe: 'Programmiersprachen' },
  { key: 'frontend', labelEn: 'Frontend & Web', labelTr: 'Frontend ve Web', labelDe: 'Frontend & Web' },
  { key: 'backend', labelEn: 'Backend & APIs', labelTr: 'Backend ve API', labelDe: 'Backend & APIs' },
  { key: 'mobile', labelEn: 'Mobile', labelTr: 'Mobil', labelDe: 'Mobile' },
  { key: 'database', labelEn: 'Databases', labelTr: 'Veritabanları', labelDe: 'Datenbanken' },
  { key: 'cloud', labelEn: 'Cloud', labelTr: 'Bulut', labelDe: 'Cloud' },
  { key: 'infrastructure', labelEn: 'Infrastructure & DevOps', labelTr: 'Altyapı ve DevOps', labelDe: 'Infrastruktur & DevOps' },
  { key: 'data', labelEn: 'Data & AI', labelTr: 'Veri ve Yapay Zeka', labelDe: 'Daten & KI' },
  { key: 'design', labelEn: 'Design', labelTr: 'Tasarım', labelDe: 'Design' },
  { key: 'testing', labelEn: 'Testing', labelTr: 'Test', labelDe: 'Testing' },
  { key: 'practice', labelEn: 'Ways of Working', labelTr: 'Çalışma Yöntemleri', labelDe: 'Arbeitsweisen' },
  { key: 'spoken', labelEn: 'Languages', labelTr: 'Yabancı Diller', labelDe: 'Sprachen' },
];

/**
 * The vocabulary. Grown from `SKILL_VOCABULARY` in `src/lib/cvParse.ts` (the
 * only curated list that existed, used for CV word-boundary matching), plus the
 * umbrella terms it lacked and the handful of skills that appear verbatim in
 * real profile data — "Power BI", "Microsoft Excel", "Entity Framework Core",
 * "Generative AI / AI Tools", "Data Analysis", "Git / GitHub", "REST API / API
 * Development", "SQL / PostgreSQL", "C# / .NET" and "Swagger / API Testing"
 * all come out of the pasted CV blob quoted at the top of `skills.ts`, which
 * is why those exact strings are aliases here.
 *
 * One line of that blob is deliberately left unresolvable: "Java C# / .NET"
 * names three skills on one line, because the CV had no separator there. It is
 * not an alias of any of them — claiming it is `csharp` would silently drop
 * the other two, and one malformed line is not a vocabulary entry.
 *
 * Kept small and defensible on purpose: a hundred entries somebody curated are
 * worth more than three hundred guesses, and every alias below is a spelling
 * that has been seen in the data or would obviously be typed.
 */
export const SKILL_SEED: readonly SkillEntry[] = [
  // ── Roles & umbrella terms ────────────────────────────────────────────────
  // What a mentee picks before they know the tool names, and what a requisition
  // asks for. The old vocabulary had none of these, so nothing could generalise.
  {
    key: 'frontend',
    labelEn: 'Frontend Development', labelTr: 'Frontend Geliştirme', labelDe: 'Frontend-Entwicklung',
    category: 'role',
    aliases: ['Front-end', 'Front End', 'Ön Yüz Geliştirme', 'Ön Uç Geliştirme', 'Frontend Entwickler'],
    adjacent: ['react', 'vue', 'angular', 'svelte', 'html', 'css', 'tailwind', 'sass', 'redux', 'nextjs', 'javascript', 'typescript', 'ui-ux-design', 'full-stack'],
  },
  {
    key: 'backend',
    labelEn: 'Backend Development', labelTr: 'Backend Geliştirme', labelDe: 'Backend-Entwicklung',
    category: 'role',
    aliases: ['Back-end', 'Back End', 'Arka Yüz Geliştirme', 'Sunucu Tarafı Geliştirme', 'Serverseitige Entwicklung'],
    adjacent: ['nodejs', 'express', 'django', 'flask', 'fastapi', 'spring', 'spring-boot', 'dotnet', 'laravel', 'rails', 'rest', 'graphql', 'sql', 'full-stack'],
  },
  {
    key: 'full-stack',
    labelEn: 'Full Stack Development', labelTr: 'Full Stack Geliştirme', labelDe: 'Full-Stack-Entwicklung',
    category: 'role',
    aliases: ['Full Stack', 'Fullstack', 'Tam Yığın Geliştirme'],
    adjacent: ['frontend', 'backend'],
  },
  {
    key: 'mobile',
    labelEn: 'Mobile Development', labelTr: 'Mobil Geliştirme', labelDe: 'Mobile Entwicklung',
    category: 'role',
    aliases: ['Mobil', 'Mobil Uygulama Geliştirme', 'App-Entwicklung'],
    adjacent: ['react-native', 'flutter', 'android', 'ios', 'kotlin', 'swift'],
  },
  {
    key: 'devops',
    labelEn: 'DevOps', labelTr: 'DevOps', labelDe: 'DevOps',
    category: 'role',
    aliases: ['DevOps Engineering', 'Site Reliability Engineering', 'SRE', 'Sistem Operasyonları'],
    adjacent: ['docker', 'kubernetes', 'terraform', 'ansible', 'linux', 'nginx', 'ci-cd', 'github-actions', 'git', 'aws', 'azure', 'gcp'],
  },
  {
    key: 'data-engineering',
    labelEn: 'Data Engineering', labelTr: 'Veri Mühendisliği', labelDe: 'Data Engineering',
    category: 'role',
    aliases: ['Datentechnik', 'Veri Mühendisi', 'Data Engineer'],
    adjacent: ['etl', 'apache-spark', 'airflow', 'sql', 'python', 'elasticsearch', 'data-analysis'],
  },
  {
    key: 'qa-testing',
    labelEn: 'QA / Testing', labelTr: 'Test / Kalite Güvence', labelDe: 'QA / Testing',
    category: 'role',
    aliases: ['QA', 'Testing', 'Test Automation', 'Test Otomasyonu', 'Yazılım Testi', 'Kalite Güvence', 'Qualitätssicherung', 'Softwaretest', 'Unit Testing', 'Birim Test'],
    adjacent: ['playwright', 'selenium', 'jest', 'ci-cd'],
  },
  {
    key: 'ui-ux-design',
    labelEn: 'UI/UX Design', labelTr: 'UI/UX Tasarım', labelDe: 'UI/UX-Design',
    category: 'role',
    aliases: ['UI/UX', 'UX Design', 'UI Design', 'Arayüz Tasarımı', 'Kullanıcı Deneyimi', 'Nutzererfahrung'],
    adjacent: ['figma', 'frontend', 'product-management'],
  },
  {
    key: 'product-management',
    labelEn: 'Product Management', labelTr: 'Ürün Yönetimi', labelDe: 'Produktmanagement',
    category: 'role',
    aliases: ['Product Owner', 'Product Manager', 'Ürün Yöneticisi', 'Produktmanager'],
    adjacent: ['agile', 'scrum', 'kanban', 'jira', 'ui-ux-design'],
  },

  // ── Programming languages ─────────────────────────────────────────────────
  {
    key: 'javascript',
    labelEn: 'JavaScript', labelTr: 'JavaScript', labelDe: 'JavaScript',
    category: 'language',
    aliases: ['JS', 'ECMAScript', 'Java Script', 'ES6'],
    adjacent: ['typescript', 'nodejs', 'react', 'frontend'],
  },
  {
    key: 'typescript',
    labelEn: 'TypeScript', labelTr: 'TypeScript', labelDe: 'TypeScript',
    category: 'language',
    aliases: ['TS', 'Type Script'],
    adjacent: ['javascript', 'react', 'nextjs', 'nodejs'],
  },
  {
    key: 'python',
    labelEn: 'Python', labelTr: 'Python', labelDe: 'Python',
    category: 'language',
    aliases: ['Python 3', 'Python3'],
    adjacent: ['django', 'flask', 'fastapi', 'pandas', 'numpy', 'machine-learning', 'data-science'],
  },
  {
    key: 'java',
    labelEn: 'Java', labelTr: 'Java', labelDe: 'Java',
    category: 'language',
    aliases: ['Core Java', 'Java SE', 'Java 17'],
    adjacent: ['spring', 'spring-boot', 'kotlin', 'android', 'backend'],
  },
  {
    key: 'csharp',
    labelEn: 'C#', labelTr: 'C#', labelDe: 'C#',
    category: 'language',
    // "C# / .NET" is one line in the real pasted CV (see skills.ts's header):
    // the person means both, and a resolver returns one key, so it lands on
    // the MORE SPECIFIC of the two — `csharp` keeps the language and reaches
    // `.NET` through adjacency, while the reverse would lose the language.
    aliases: ['C Sharp', 'C# / .NET', 'C#/.NET'],
    adjacent: ['dotnet', 'entity-framework', 'backend'],
  },
  {
    key: 'cpp',
    labelEn: 'C++', labelTr: 'C++', labelDe: 'C++',
    category: 'language',
    aliases: ['C Plus Plus'],
    adjacent: ['c', 'rust'],
  },
  {
    key: 'c',
    labelEn: 'C', labelTr: 'C', labelDe: 'C',
    category: 'language',
    aliases: ['C Language', 'C Programlama', 'C-Programmierung'],
    adjacent: ['cpp', 'linux'],
  },
  {
    key: 'go',
    labelEn: 'Go', labelTr: 'Go', labelDe: 'Go',
    category: 'language',
    aliases: ['Golang'],
    adjacent: ['backend', 'kubernetes'],
  },
  {
    key: 'rust',
    labelEn: 'Rust', labelTr: 'Rust', labelDe: 'Rust',
    category: 'language',
    aliases: ['Rust Lang'],
    adjacent: ['cpp'],
  },
  {
    key: 'ruby',
    labelEn: 'Ruby', labelTr: 'Ruby', labelDe: 'Ruby',
    category: 'language',
    aliases: [],
    adjacent: ['rails', 'backend'],
  },
  {
    key: 'php',
    labelEn: 'PHP', labelTr: 'PHP', labelDe: 'PHP',
    category: 'language',
    aliases: ['PHP 8'],
    adjacent: ['laravel', 'backend'],
  },
  {
    key: 'kotlin',
    labelEn: 'Kotlin', labelTr: 'Kotlin', labelDe: 'Kotlin',
    category: 'language',
    aliases: [],
    adjacent: ['java', 'android', 'mobile'],
  },
  {
    key: 'swift',
    labelEn: 'Swift', labelTr: 'Swift', labelDe: 'Swift',
    category: 'language',
    aliases: [],
    adjacent: ['ios', 'mobile'],
  },
  {
    key: 'scala',
    labelEn: 'Scala', labelTr: 'Scala', labelDe: 'Scala',
    category: 'language',
    aliases: [],
    adjacent: ['java', 'apache-spark'],
  },

  // ── Frontend & web ────────────────────────────────────────────────────────
  {
    key: 'react',
    labelEn: 'React', labelTr: 'React', labelDe: 'React',
    category: 'frontend',
    aliases: ['React.js', 'ReactJS', 'React JS'],
    adjacent: ['javascript', 'typescript', 'nextjs', 'redux', 'react-native', 'frontend'],
  },
  {
    key: 'nextjs',
    labelEn: 'Next.js', labelTr: 'Next.js', labelDe: 'Next.js',
    category: 'frontend',
    aliases: ['Next JS', 'Next'],
    adjacent: ['react', 'typescript', 'frontend', 'backend'],
  },
  {
    key: 'vue',
    labelEn: 'Vue', labelTr: 'Vue', labelDe: 'Vue',
    category: 'frontend',
    aliases: ['Vue.js', 'VueJS', 'Vue 3'],
    adjacent: ['javascript', 'frontend'],
  },
  {
    key: 'angular',
    labelEn: 'Angular', labelTr: 'Angular', labelDe: 'Angular',
    category: 'frontend',
    aliases: ['AngularJS', 'Angular 2+'],
    adjacent: ['typescript', 'frontend'],
  },
  {
    key: 'svelte',
    labelEn: 'Svelte', labelTr: 'Svelte', labelDe: 'Svelte',
    category: 'frontend',
    aliases: ['SvelteKit'],
    adjacent: ['javascript', 'frontend'],
  },
  {
    key: 'html',
    labelEn: 'HTML', labelTr: 'HTML', labelDe: 'HTML',
    category: 'frontend',
    aliases: ['HTML5'],
    adjacent: ['css', 'frontend'],
  },
  {
    key: 'css',
    labelEn: 'CSS', labelTr: 'CSS', labelDe: 'CSS',
    category: 'frontend',
    aliases: ['CSS3'],
    adjacent: ['html', 'sass', 'tailwind', 'frontend'],
  },
  {
    key: 'tailwind',
    labelEn: 'Tailwind CSS', labelTr: 'Tailwind CSS', labelDe: 'Tailwind CSS',
    category: 'frontend',
    aliases: ['TailwindCSS'],
    adjacent: ['css', 'frontend'],
  },
  {
    key: 'sass',
    labelEn: 'Sass', labelTr: 'Sass', labelDe: 'Sass',
    category: 'frontend',
    aliases: ['SCSS', 'Sass/SCSS'],
    adjacent: ['css', 'frontend'],
  },
  {
    key: 'redux',
    labelEn: 'Redux', labelTr: 'Redux', labelDe: 'Redux',
    category: 'frontend',
    aliases: ['Redux Toolkit'],
    adjacent: ['react', 'frontend'],
  },

  // ── Backend & APIs ────────────────────────────────────────────────────────
  {
    key: 'nodejs',
    labelEn: 'Node.js', labelTr: 'Node.js', labelDe: 'Node.js',
    category: 'backend',
    aliases: ['Node', 'Node JS'],
    adjacent: ['javascript', 'typescript', 'express', 'backend'],
  },
  {
    key: 'express',
    labelEn: 'Express', labelTr: 'Express', labelDe: 'Express',
    category: 'backend',
    aliases: ['Express.js', 'ExpressJS'],
    adjacent: ['nodejs', 'backend'],
  },
  {
    key: 'django',
    labelEn: 'Django', labelTr: 'Django', labelDe: 'Django',
    category: 'backend',
    aliases: ['Django REST Framework', 'DRF'],
    adjacent: ['python', 'backend'],
  },
  {
    key: 'flask',
    labelEn: 'Flask', labelTr: 'Flask', labelDe: 'Flask',
    category: 'backend',
    aliases: [],
    adjacent: ['python', 'backend'],
  },
  {
    key: 'fastapi',
    labelEn: 'FastAPI', labelTr: 'FastAPI', labelDe: 'FastAPI',
    category: 'backend',
    aliases: ['Fast API'],
    adjacent: ['python', 'rest', 'backend'],
  },
  {
    key: 'spring',
    labelEn: 'Spring', labelTr: 'Spring', labelDe: 'Spring',
    category: 'backend',
    aliases: ['Spring Framework'],
    adjacent: ['java', 'spring-boot', 'backend'],
  },
  {
    key: 'spring-boot',
    labelEn: 'Spring Boot', labelTr: 'Spring Boot', labelDe: 'Spring Boot',
    category: 'backend',
    aliases: ['SpringBoot'],
    adjacent: ['spring', 'java', 'backend'],
  },
  {
    key: 'dotnet',
    labelEn: '.NET', labelTr: '.NET', labelDe: '.NET',
    category: 'backend',
    aliases: ['.NET Core', 'ASP.NET', 'dot net'],
    adjacent: ['csharp', 'entity-framework', 'backend'],
  },
  {
    key: 'laravel',
    labelEn: 'Laravel', labelTr: 'Laravel', labelDe: 'Laravel',
    category: 'backend',
    aliases: [],
    adjacent: ['php', 'backend'],
  },
  {
    key: 'rails',
    labelEn: 'Ruby on Rails', labelTr: 'Ruby on Rails', labelDe: 'Ruby on Rails',
    category: 'backend',
    aliases: ['RoR'],
    adjacent: ['ruby', 'backend'],
  },
  {
    key: 'entity-framework',
    labelEn: 'Entity Framework', labelTr: 'Entity Framework', labelDe: 'Entity Framework',
    category: 'backend',
    // "Entity Framework Core" is how it appears verbatim in real profile data.
    aliases: ['Entity Framework Core', 'EF Core'],
    adjacent: ['dotnet', 'csharp', 'sql'],
  },
  {
    key: 'rest',
    labelEn: 'REST API', labelTr: 'REST API', labelDe: 'REST-API',
    category: 'backend',
    // The composite spelling is one people paste out of their CV as a unit.
    aliases: ['RESTful', 'API Development', 'REST API / API Development', 'API Geliştirme', 'Web Servisleri'],
    adjacent: ['graphql', 'backend'],
  },
  {
    key: 'swagger',
    labelEn: 'Swagger / OpenAPI', labelTr: 'Swagger / OpenAPI', labelDe: 'Swagger / OpenAPI',
    category: 'backend',
    // "Swagger / API Testing" is a verbatim line from the pasted CV, and the
    // tool had no entry at all — a REST developer's most common second skill
    // resolved to nothing. `swagger` rather than `openapi` as the key because
    // that is what people write; both are indexed either way.
    aliases: ['OpenAPI', 'Swagger / API Testing', 'API Testing', 'API Dokümantasyonu'],
    adjacent: ['rest', 'qa-testing', 'backend'],
  },
  {
    key: 'graphql',
    labelEn: 'GraphQL', labelTr: 'GraphQL', labelDe: 'GraphQL',
    category: 'backend',
    aliases: ['Graph QL'],
    adjacent: ['rest', 'nodejs', 'backend'],
  },
  {
    key: 'trpc',
    labelEn: 'tRPC', labelTr: 'tRPC', labelDe: 'tRPC',
    category: 'backend',
    aliases: [],
    adjacent: ['typescript', 'nextjs'],
  },

  // ── Mobile ────────────────────────────────────────────────────────────────
  {
    key: 'react-native',
    labelEn: 'React Native', labelTr: 'React Native', labelDe: 'React Native',
    category: 'mobile',
    aliases: ['RN'],
    adjacent: ['react', 'mobile'],
  },
  {
    key: 'flutter',
    labelEn: 'Flutter', labelTr: 'Flutter', labelDe: 'Flutter',
    category: 'mobile',
    aliases: [],
    adjacent: ['mobile'],
  },
  {
    key: 'android',
    labelEn: 'Android', labelTr: 'Android', labelDe: 'Android',
    category: 'mobile',
    aliases: ['Android Development', 'Android SDK', 'Android Geliştirme'],
    adjacent: ['kotlin', 'java', 'mobile'],
  },
  {
    key: 'ios',
    labelEn: 'iOS', labelTr: 'iOS', labelDe: 'iOS',
    category: 'mobile',
    aliases: ['iOS Development', 'iPhone Development', 'iOS Geliştirme'],
    adjacent: ['swift', 'mobile'],
  },

  // ── Databases ─────────────────────────────────────────────────────────────
  {
    key: 'sql',
    labelEn: 'SQL', labelTr: 'SQL', labelDe: 'SQL',
    category: 'database',
    aliases: ['Structured Query Language', 'SQL Sorguları'],
    adjacent: ['mysql', 'postgresql', 'database-management', 'data-analysis'],
  },
  {
    key: 'mysql',
    labelEn: 'MySQL', labelTr: 'MySQL', labelDe: 'MySQL',
    category: 'database',
    aliases: ['My SQL'],
    adjacent: ['sql', 'mariadb'],
  },
  {
    key: 'postgresql',
    labelEn: 'PostgreSQL', labelTr: 'PostgreSQL', labelDe: 'PostgreSQL',
    category: 'database',
    // "SQL / PostgreSQL" is another verbatim line from that CV. Same rule as
    // "C# / .NET": the more specific key wins, and `sql` is one adjacency hop
    // away. (Deliberately NOT on `sql`, which would throw the product away.)
    aliases: ['Postgres', 'PSQL', 'Postgre', 'SQL / PostgreSQL'],
    adjacent: ['sql', 'prisma'],
  },
  {
    key: 'mariadb',
    labelEn: 'MariaDB', labelTr: 'MariaDB', labelDe: 'MariaDB',
    category: 'database',
    aliases: ['Maria DB'],
    adjacent: ['mysql', 'sql'],
  },
  {
    key: 'mongodb',
    labelEn: 'MongoDB', labelTr: 'MongoDB', labelDe: 'MongoDB',
    category: 'database',
    // NOT 'NoSQL': see the umbrella rule in the house style above. Redis and
    // Elasticsearch are in this vocabulary and are also NoSQL stores, so
    // "NoSQL" → mongodb would tag a Redis engineer as a MongoDB engineer.
    aliases: ['Mongo', 'Mongo DB'],
    adjacent: ['nodejs', 'database-management'],
  },
  {
    key: 'redis',
    labelEn: 'Redis', labelTr: 'Redis', labelDe: 'Redis',
    category: 'database',
    aliases: [],
    adjacent: ['database-management'],
  },
  {
    key: 'sqlite',
    labelEn: 'SQLite', labelTr: 'SQLite', labelDe: 'SQLite',
    category: 'database',
    aliases: ['SQL Lite'],
    adjacent: ['sql'],
  },
  {
    key: 'prisma',
    labelEn: 'Prisma', labelTr: 'Prisma', labelDe: 'Prisma',
    category: 'database',
    aliases: ['Prisma ORM'],
    adjacent: ['typescript', 'postgresql', 'nodejs'],
  },
  {
    key: 'elasticsearch',
    labelEn: 'Elasticsearch', labelTr: 'Elasticsearch', labelDe: 'Elasticsearch',
    category: 'database',
    aliases: ['Elastic Search', 'Elastic', 'ELK'],
    adjacent: ['database-management', 'data-engineering'],
  },
  {
    key: 'database-management',
    labelEn: 'Database Management', labelTr: 'Veritabanı Yönetimi', labelDe: 'Datenbankadministration',
    category: 'database',
    aliases: ['DBA', 'Database Administration', 'Datenbankverwaltung'],
    adjacent: ['sql', 'mysql', 'postgresql'],
  },

  // ── Cloud ─────────────────────────────────────────────────────────────────
  {
    key: 'aws',
    labelEn: 'AWS', labelTr: 'AWS', labelDe: 'AWS',
    category: 'cloud',
    aliases: ['Amazon Web Services', 'AWS Cloud'],
    adjacent: ['azure', 'gcp', 'devops', 'docker'],
  },
  {
    key: 'azure',
    labelEn: 'Azure', labelTr: 'Azure', labelDe: 'Azure',
    category: 'cloud',
    aliases: ['Microsoft Azure'],
    adjacent: ['aws', 'gcp', 'devops', 'dotnet'],
  },
  {
    key: 'gcp',
    labelEn: 'Google Cloud', labelTr: 'Google Cloud', labelDe: 'Google Cloud',
    category: 'cloud',
    aliases: ['Google Cloud Platform'],
    adjacent: ['aws', 'azure', 'devops', 'kubernetes'],
  },

  // ── Infrastructure & DevOps ───────────────────────────────────────────────
  {
    key: 'docker',
    labelEn: 'Docker', labelTr: 'Docker', labelDe: 'Docker',
    category: 'infrastructure',
    aliases: ['Docker Compose', 'Containerization', 'Konteynerizasyon'],
    adjacent: ['kubernetes', 'devops', 'linux'],
  },
  {
    key: 'kubernetes',
    labelEn: 'Kubernetes', labelTr: 'Kubernetes', labelDe: 'Kubernetes',
    category: 'infrastructure',
    aliases: ['k8s', 'Kube'],
    adjacent: ['docker', 'devops'],
  },
  {
    key: 'terraform',
    labelEn: 'Terraform', labelTr: 'Terraform', labelDe: 'Terraform',
    category: 'infrastructure',
    aliases: ['Infrastructure as Code', 'IaC'],
    adjacent: ['ansible', 'devops'],
  },
  {
    key: 'ansible',
    labelEn: 'Ansible', labelTr: 'Ansible', labelDe: 'Ansible',
    category: 'infrastructure',
    aliases: [],
    adjacent: ['terraform', 'linux', 'devops'],
  },
  {
    key: 'linux',
    labelEn: 'Linux', labelTr: 'Linux', labelDe: 'Linux',
    category: 'infrastructure',
    aliases: ['GNU/Linux', 'Unix', 'Bash'],
    adjacent: ['nginx', 'docker', 'devops'],
  },
  {
    key: 'nginx',
    labelEn: 'Nginx', labelTr: 'Nginx', labelDe: 'Nginx',
    category: 'infrastructure',
    aliases: ['Reverse Proxy'],
    adjacent: ['linux', 'devops'],
  },
  {
    key: 'ci-cd',
    labelEn: 'CI/CD', labelTr: 'CI/CD', labelDe: 'CI/CD',
    category: 'infrastructure',
    aliases: ['CI / CD', 'Continuous Integration', 'Continuous Delivery', 'Sürekli Entegrasyon', 'Kontinuierliche Integration'],
    adjacent: ['github-actions', 'docker', 'devops'],
  },
  {
    key: 'git',
    labelEn: 'Git', labelTr: 'Git', labelDe: 'Git',
    category: 'infrastructure',
    // "Git / GitHub" is a single pill in real profile data.
    aliases: ['Git / GitHub', 'GitHub', 'Version Control', 'Versiyon Kontrolü', 'Versionskontrolle'],
    adjacent: ['github-actions', 'devops'],
  },
  {
    key: 'github-actions',
    labelEn: 'GitHub Actions', labelTr: 'GitHub Actions', labelDe: 'GitHub Actions',
    category: 'infrastructure',
    aliases: ['GH Actions'],
    adjacent: ['ci-cd', 'git', 'devops'],
  },

  // ── Data & AI ─────────────────────────────────────────────────────────────
  {
    key: 'machine-learning',
    labelEn: 'Machine Learning', labelTr: 'Makine Öğrenmesi', labelDe: 'Maschinelles Lernen',
    category: 'data',
    aliases: ['ML', 'Makine Öğrenimi'],
    adjacent: ['python', 'tensorflow', 'pytorch', 'scikit-learn', 'data-science', 'nlp', 'generative-ai'],
  },
  {
    key: 'data-science',
    labelEn: 'Data Science', labelTr: 'Veri Bilimi', labelDe: 'Data Science',
    category: 'data',
    aliases: ['Datenwissenschaft', 'Data Scientist'],
    adjacent: ['python', 'pandas', 'numpy', 'machine-learning', 'data-analysis'],
  },
  {
    key: 'nlp',
    labelEn: 'NLP', labelTr: 'Doğal Dil İşleme', labelDe: 'Natural Language Processing',
    category: 'data',
    aliases: ['Sprachverarbeitung', 'Computerlinguistik'],
    adjacent: ['machine-learning', 'python', 'generative-ai'],
  },
  {
    key: 'generative-ai',
    labelEn: 'Generative AI', labelTr: 'Üretken Yapay Zeka', labelDe: 'Generative KI',
    category: 'data',
    // The first spelling is verbatim from a pasted CV skills list.
    aliases: ['Generative AI / AI Tools', 'GenAI', 'LLM', 'Yapay Zeka Araçları', 'KI-Tools'],
    adjacent: ['machine-learning', 'nlp', 'python'],
  },
  {
    key: 'tensorflow',
    labelEn: 'TensorFlow', labelTr: 'TensorFlow', labelDe: 'TensorFlow',
    category: 'data',
    aliases: ['Tensor Flow', 'Keras'],
    adjacent: ['machine-learning', 'python'],
  },
  {
    key: 'pytorch',
    labelEn: 'PyTorch', labelTr: 'PyTorch', labelDe: 'PyTorch',
    category: 'data',
    aliases: ['Py Torch', 'Torch'],
    adjacent: ['machine-learning', 'python'],
  },
  {
    key: 'pandas',
    labelEn: 'Pandas', labelTr: 'Pandas', labelDe: 'Pandas',
    category: 'data',
    aliases: [],
    adjacent: ['python', 'numpy', 'data-analysis'],
  },
  {
    key: 'numpy',
    labelEn: 'NumPy', labelTr: 'NumPy', labelDe: 'NumPy',
    category: 'data',
    aliases: ['Num Py'],
    adjacent: ['python', 'pandas'],
  },
  {
    key: 'scikit-learn',
    labelEn: 'scikit-learn', labelTr: 'scikit-learn', labelDe: 'scikit-learn',
    category: 'data',
    aliases: ['sklearn', 'Scikit Learn'],
    adjacent: ['machine-learning', 'python'],
  },
  {
    key: 'data-analysis',
    labelEn: 'Data Analysis', labelTr: 'Veri Analizi', labelDe: 'Datenanalyse',
    category: 'data',
    aliases: ['Data Analytics', 'Veri Analitiği'],
    adjacent: ['excel', 'power-bi', 'sql', 'pandas', 'data-science'],
  },
  {
    key: 'power-bi',
    labelEn: 'Power BI', labelTr: 'Power BI', labelDe: 'Power BI',
    category: 'data',
    aliases: ['PowerBI', 'Microsoft Power BI'],
    adjacent: ['data-analysis', 'excel', 'sql'],
  },
  {
    key: 'excel',
    labelEn: 'Microsoft Excel', labelTr: 'Microsoft Excel', labelDe: 'Microsoft Excel',
    category: 'data',
    aliases: ['MS Excel', 'Excel Tabloları', 'Pivot Table'],
    adjacent: ['data-analysis', 'power-bi'],
  },
  {
    key: 'etl',
    labelEn: 'ETL', labelTr: 'ETL Süreçleri', labelDe: 'ETL-Prozesse',
    category: 'data',
    aliases: ['Data Pipelines', 'Veri Boru Hatları', 'Datenpipelines'],
    adjacent: ['data-engineering', 'sql', 'airflow'],
  },
  {
    key: 'apache-spark',
    labelEn: 'Apache Spark', labelTr: 'Apache Spark', labelDe: 'Apache Spark',
    category: 'data',
    aliases: ['Spark', 'PySpark'],
    adjacent: ['data-engineering', 'scala', 'python'],
  },
  {
    key: 'airflow',
    labelEn: 'Apache Airflow', labelTr: 'Apache Airflow', labelDe: 'Apache Airflow',
    category: 'data',
    aliases: [],
    adjacent: ['data-engineering', 'etl', 'python'],
  },

  // ── Design ────────────────────────────────────────────────────────────────
  {
    key: 'figma',
    labelEn: 'Figma', labelTr: 'Figma', labelDe: 'Figma',
    category: 'design',
    aliases: [],
    adjacent: ['ui-ux-design'],
  },

  // ── Testing ───────────────────────────────────────────────────────────────
  {
    key: 'playwright',
    labelEn: 'Playwright', labelTr: 'Playwright', labelDe: 'Playwright',
    category: 'testing',
    aliases: [],
    adjacent: ['qa-testing', 'typescript'],
  },
  {
    key: 'selenium',
    labelEn: 'Selenium', labelTr: 'Selenium', labelDe: 'Selenium',
    category: 'testing',
    aliases: ['Selenium WebDriver'],
    adjacent: ['qa-testing'],
  },
  {
    key: 'jest',
    labelEn: 'Jest', labelTr: 'Jest', labelDe: 'Jest',
    category: 'testing',
    aliases: [],
    adjacent: ['qa-testing', 'javascript'],
  },

  // ── Ways of working ───────────────────────────────────────────────────────
  {
    key: 'agile',
    // "Agile" is what a Turkish or German practitioner writes; "Çevik" and
    // "agiles Arbeiten" belong in the aliases, not in the picker.
    labelEn: 'Agile', labelTr: 'Agile', labelDe: 'Agile',
    category: 'practice',
    aliases: ['Çevik', 'Çevik Metodolojiler', 'Agile Methoden', 'Agiles Arbeiten'],
    adjacent: ['scrum', 'kanban', 'jira', 'product-management'],
  },
  {
    key: 'scrum',
    labelEn: 'Scrum', labelTr: 'Scrum', labelDe: 'Scrum',
    category: 'practice',
    aliases: ['Scrum Master'],
    adjacent: ['agile', 'kanban', 'jira'],
  },
  {
    key: 'kanban',
    labelEn: 'Kanban', labelTr: 'Kanban', labelDe: 'Kanban',
    category: 'practice',
    aliases: [],
    adjacent: ['agile', 'scrum', 'jira'],
  },
  {
    key: 'jira',
    labelEn: 'Jira', labelTr: 'Jira', labelDe: 'Jira',
    category: 'practice',
    aliases: ['Atlassian Jira'],
    adjacent: ['agile', 'scrum', 'product-management'],
  },

  // ── Spoken languages ──────────────────────────────────────────────────────
  // No adjacency on purpose: knowing English says nothing about knowing German,
  // and a near-neighbour link here would only pollute a match.
  {
    key: 'english',
    labelEn: 'English', labelTr: 'İngilizce', labelDe: 'Englisch',
    category: 'spoken',
    aliases: ['Business English', 'İleri Seviye İngilizce'],
    adjacent: [],
  },
  {
    key: 'german',
    labelEn: 'German', labelTr: 'Almanca', labelDe: 'Deutsch',
    category: 'spoken',
    aliases: ['Deutschkenntnisse'],
    adjacent: [],
  },
  {
    key: 'turkish',
    labelEn: 'Turkish', labelTr: 'Türkçe', labelDe: 'Türkisch',
    category: 'spoken',
    aliases: [],
    adjacent: [],
  },
  {
    key: 'french',
    labelEn: 'French', labelTr: 'Fransızca', labelDe: 'Französisch',
    category: 'spoken',
    aliases: [],
    adjacent: [],
  },
  {
    key: 'spanish',
    labelEn: 'Spanish', labelTr: 'İspanyolca', labelDe: 'Spanisch',
    category: 'spoken',
    aliases: [],
    adjacent: [],
  },
];

/** The label a user sees, in their locale. */
export function skillSeedLabel(entry: SkillEntry, locale: SkillLocale): string {
  if (locale === 'tr') return entry.labelTr;
  if (locale === 'de') return entry.labelDe;
  return entry.labelEn;
}

/** The three labels of one entry, in a fixed order (en, tr, de). */
export function skillSeedLabels(entry: SkillEntry): readonly string[] {
  return [entry.labelEn, entry.labelTr, entry.labelDe];
}

export interface SkillIndex {
  /** key → entry. */
  byKey: ReadonlyMap<string, SkillEntry>;
  /**
   * Folded lookup token → key. Every key, every label and every alias is a
   * token, so "React", "react", "ReactJS" and "React.js" all land on `react`.
   */
  tokens: ReadonlyMap<string, string>;
  /** key → near-neighbour keys, symmetric, de-duplicated and sorted. */
  adjacency: ReadonlyMap<string, readonly string[]>;
  /** The fold the tokens were built with — so a lookup uses the same one. */
  fold: (value: string) => string;
}

/**
 * Build the lookup index.
 *
 * `fold` is `skillKey()` from `src/lib/skills.ts` — passed in rather than
 * imported so this module stays loadable by a plain Node script (see the
 * header) while there is still exactly ONE fold in the codebase.
 *
 * Deliberately tolerant: a duplicate token keeps its first claimant instead of
 * throwing, and an adjacency pointing at an unknown key is dropped.
 * `npm run check:skills` is what turns either into a red build — a request that
 * renders a picker must never 500 over a vocabulary typo.
 */
export function buildSkillIndex(
  fold: (value: string) => string,
  seed: readonly SkillEntry[] = SKILL_SEED,
): SkillIndex {
  const byKey = new Map<string, SkillEntry>();
  const tokens = new Map<string, string>();
  for (const entry of seed) {
    if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
    for (const token of [entry.key, ...skillSeedLabels(entry), ...entry.aliases]) {
      const folded = fold(token);
      if (folded && !tokens.has(folded)) tokens.set(folded, entry.key);
    }
  }

  const neighbours = new Map<string, Set<string>>();
  for (const entry of seed) neighbours.set(entry.key, new Set<string>());
  for (const entry of seed) {
    for (const other of entry.adjacent) {
      if (other === entry.key || !byKey.has(other)) continue;
      neighbours.get(entry.key)?.add(other);
      neighbours.get(other)?.add(entry.key);
    }
  }

  const adjacency = new Map<string, readonly string[]>();
  for (const [key, set] of neighbours) adjacency.set(key, [...set].sort());
  return { byKey, tokens, adjacency, fold };
}

/** The canonical key behind anything a user typed, or `null` if it is not in the vocabulary. */
export function resolveSeedKey(index: SkillIndex, raw: string): string | null {
  return index.tokens.get(index.fold(raw)) ?? null;
}

/** The entry behind anything a user typed, or `null`. */
export function resolveSeedEntry(index: SkillIndex, raw: string): SkillEntry | null {
  const key = resolveSeedKey(index, raw);
  return key ? index.byKey.get(key) ?? null : null;
}

/** Near-neighbour keys of one skill; empty for an unknown key. */
export function seedNeighbours(index: SkillIndex, key: string): readonly string[] {
  return index.adjacency.get(key) ?? [];
}
