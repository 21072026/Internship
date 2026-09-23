// Per-vertical terminology overlays (#2354, epic #2348).
//
// coreCRM serves several products from one dictionary. A MARKETING tenant should
// not read "candidate" and "mentee" where it means "lead" — so a vertical may
// override individual dictionary strings through an overlay that is deep-merged
// onto the base translation.
//
// THE NO-OP RULE: INTERNSHIP overrides nothing. Its overlay is empty in every
// locale, so getDictionary(locale, 'INTERNSHIP') deep-merges nothing and returns
// output byte-identical to getDictionary(locale). Today every tenant is
// INTERNSHIP, so the whole overlay layer is invisible for the live product — and
// the many e2e specs that assert exact strings keep passing because they run on
// INTERNSHIP/default orgs.
//
// Overlays are PARTIAL and only ever REPLACE a leaf string that already exists;
// they never add keys (check-i18n enforces both — a typo'd overlay key that
// matches nothing is a silent no-op, so it is a build error instead). The set is
// intentionally small and grows as real marketing surfaces are dressed; it does
// not attempt to translate the whole 4800-key dictionary at once.

import type { Locale } from './config';
import type { Dictionary } from './dictionaries';
import type { VerticalKey } from '@/lib/verticals';

// The default vertical, inlined as a literal (not imported as a value) so this
// module has NO runtime imports and can therefore be loaded by the plain node
// runner that scripts/check-i18n.ts uses — which is what lets that guard
// validate the overlays. Kept in sync with DEFAULT_VERTICAL in src/lib/verticals.ts
// by the vertical-overlays unit spec, which imports both.
const DEFAULT_VERTICAL: VerticalKey = 'INTERNSHIP';

// A recursively-optional view of the dictionary: an overlay may carry any
// subtree down to a replaced leaf string, and nothing it omits.
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends string ? T[K] : DeepPartial<T[K]>;
};

type LocaleOverlay = DeepPartial<Dictionary>;

// One entry per vertical. INTERNSHIP is present and empty ON PURPOSE — the
// emptiness is the no-op guarantee, and a test asserts it stays empty.
const OVERLAYS: Record<VerticalKey, Record<Locale, LocaleOverlay>> = {
  INTERNSHIP: { en: {}, tr: {}, de: {} },
  MARKETING: {
    en: {
      nav: { candidates: 'Leads' },
      candidates: {
        title: 'Leads',
        subtitle: 'Browse and search leads',
        // `mentor` is the "Mentor: {name}" line on a candidate row AND inside the
        // person hover card, which the board renders on every card's owner chip.
        mentor: 'Rep',
        mineFilter: 'My accounts',
        // The bulk control assigns the person `mentor` above names, so it says
        // the same word — the action key stays `assignOwner` (#2439), only the
        // label follows the vertical.
        bulkOwnerLabel: 'Rep',
        bulkAssignOwner: 'Assign rep',
      },
      // Public chrome + auth pages (#2501): the header aria-label, footer
      // tagline and sign-in/register copy a marketing visitor reads.
      publicNav: {
        homeLink: 'SaleVali — go to the home page',
        tagline: 'Leads, accounts and deals in one pipeline — from first contact to close.',
      },
      auth: {
        signinSubtitle: 'Sign in to your SaleVali account',
        registerSubtitle: 'Register with your invitation',
        tokenHint: 'Paste the invitation token from your e-mail. Accounts on this product are created by invitation.',
      },
      // The admin dashboard (#2498). People = leads, the pipeline relation = a
      // deal — so "mentee/mentor/mentorship" become "lead/rep/deal" and nothing
      // reads "internship" to a marketing tenant.
      dashboard: {
        subtitle: 'Overview of your marketing pipeline',
        mentees: 'Leads',
        mentors: 'Reps',
        activeMentorships: 'Active deals',
        perStage: 'Leads per stage',
        recentMentorships: 'Recent deals',
        latestAssignments: 'Latest deals',
        noMentorships: 'No deals yet',
        newCandidates: 'New Leads',
        recentlyRegistered: 'Recently added leads',
        noCandidates: 'No leads yet',
        quickActions: { browseCandidates: 'Browse Leads' },
      },
      checklist: {
        steps: {
          inviteMentors: 'Invite your first reps',
          inviteMentees: 'Add your first leads',
          assignMentorship: 'Create the first deal',
        },
      },
      // The company list (#2426, story #2394). A marketing tenant's companies
      // are the ACCOUNTS it sells to: the relation counter is a deal, a
      // CompanyNeed is what the account needs, and a company login follows its
      // leads. "Companies" itself stays — the Company model is the account
      // master in both products, and the nav says the same word.
      //
      // This is the WHOLE of `companiesPage` whose English still reads like the
      // internship product ("…their internship needs", "mentorships",
      // "positions", "its linked candidates"). Every other key in the namespace
      // is either neutral (title, search, the failure toasts) or names a field
      // that means the same thing in both products, so it is left alone — an
      // overlay entry that changes nothing is noise the next reader has to
      // re-derive.
      companiesPage: {
        subtitle: 'Manage the accounts you sell to and what each one needs',
        addLoginHint: 'Create a read-only login for a company to follow its linked leads.',
        mentorships: 'deals',
        positions: 'needs',
        openPositions: 'Open needs',
      },
      // The two DIALOGS /admin/companies opens are part of that page, so the
      // acceptance ("no mentorship word on /admin/companies") covers them: the
      // create/edit form — whose empty-state CTA is the first control a day-one
      // tenant clicks — and the premium-features modal behind the Sparkles
      // button on every card. Only the keys whose English still names the
      // internship product are overridden; the rest of both namespaces is field
      // labels that mean the same thing in either product.
      companyForm: {
        quota: 'Need quota',
        needs: 'Account needs',
        noNeeds: 'No needs added yet. Click "Add Need" to record what this account needs.',
      },
      entitlements: {
        subtitle: 'Enable premium features for {name}. Rep and lead features are always free.',
      },
      // The stage board (#2427): every card is a lead owned by a rep, the pair
      // is a deal.
      //
      // Stage NAMES need nothing here, deliberately: a MARKETING org is
      // provisioned with MARKETING_FUNNEL (provisionStagePreset), whose stages
      // carry their own en/tr/de labels that stageLabel() resolves. A second
      // translation layer for stage names is exactly what #2427 rules out.
      //
      // `board.emptyStage` has no reader in src today — the admin board renders
      // an empty column rather than a message. It is overridden anyway: the key
      // is live in all three locales, and whoever renders it next must not
      // reintroduce "No mentees in this stage" on a marketing board.
      //
      // The group headings need all three: MARKETING_FUNNEL's keys are its own
      // (LEAD_*/DEAL_*), so groupResolvedStages() files every one of them under
      // `custom` — that is the ONE heading a provisioned marketing tenant
      // actually sees, and "Custom stages" describes a deviation from a
      // programme it does not run. `pre`/`internship` still get an override
      // because an org switched to MARKETING while sitting on the canonical
      // stage keys renders them, and those two read "Pre-internship"/"Internship".
      board: { emptyStage: 'No leads in this stage' },
      adminBoard: {
        subtitle: 'Every lead across every rep — drag a card, or use the stage menu on it, to change its stage',
        searchPlaceholder: 'Find a lead or rep...',
        wipSaturated: 'Every column on this board is over its work-in-progress limit, so the amber warning no longer points anywhere and is hidden. Set a limit that matches how this pipeline actually runs — one number for the board, or one per stage.',
        groups: { pre: 'Leads', internship: 'Deals', custom: 'Funnel' },
      },
      // PersonHoverCard is shared chrome, but the board opens one on EVERY
      // card's owner chip (hover, tap or keyboard focus), and it announces the
      // person's role — so "Mentor"/"Mentee" are on the very screen #2427
      // names. These are the same two words `dashboard.mentors`/`mentees`
      // already rename, so the decision is not a new one. The rest of the
      // namespace (admin/company/source, "Open profile", "Message") is neutral
      // and left alone.
      personCard: { roleMentor: 'Rep', roleMentee: 'Lead' },
      // The day-one empty states of the same two screens (both rendered by the
      // pages #2426/#2427 name, so the acceptance "no mentorship word on
      // /admin/companies or the board" is not met without them): a fresh tenant
      // reads these before anything else, so they must not explain internships.
      emptyStates: {
        board: {
          adminBody: 'Every deal shows up here as a card, in the stage it has reached. Add the first leads and their cards appear as soon as a rep owns them.',
        },
        companies: {
          adminBody: 'Companies are the accounts you sell to: once one exists you can attach what it needs, its contact people and the deals open against it.',
        },
      },
      landing: {
        // The lean marketing landing (#2500): the sections that survive for a
        // MARKETING host — hero, chips, feature cards, the funnel diagram, "and
        // more", transparency, CTA — re-worded for a sales team. The internship
        // argument (loop, role picker, audiences, free core, how-it-works, roles,
        // stories, FAQ) is not rendered for this vertical, so it is not overlaid.
        chipStages: 'One pipeline from lead to closed deal',
        chipRoles: 'Open source — AGPL-3.0',
        chipLangs: 'English · Türkçe · Deutsch',
        chipGdpr: 'Your customer data stays yours',
        fPipelineT: 'Pipeline tracking',
        fPipelineD: 'Every lead on one board, from new to won or lost — drag-and-drop stages, a deadline per stage with overdue flags, and a full history of who moved what and when.',
        fCompanyT: 'Accounts & contacts',
        fCompanyD: 'Track the companies you sell to and the people inside them, log what each account needs, and see every open deal against it in one place.',
        fCommsT: 'Communication',
        fCommsD: 'Meeting invites with RSVP, in-app messaging on every deal, single and bulk emails, announcements, per-category notification preferences, reminders and a weekly digest.',
        fDocsT: 'Documents & templates',
        fDocsD: 'Versioned uploads on any lead or account, a multilingual template library for proposals and follow-ups with in-app preview and PDF export.',
        fAnalyticsT: 'Analytics & insights',
        fAnalyticsD: 'Conversion funnel, time and ageing per stage, deals per rep and their outcomes, six-month trends with a date-range selector.',
        fPrivacyT: 'Access & privacy',
        fPrivacyD: 'Role-based access, two-factor authentication, email verification, an activity log, and a full GDPR toolkit: consent, retention reminders, erasure and one-click data export.',
        fPlatformT: 'A pleasant place to work',
        fPlatformD: 'Three languages (EN/TR/DE), dark mode, adjustable font size, global search, installable as an app (PWA) with offline support, and a public “What’s new” page.',
        pipelineTitle: 'From first contact to closed deal',
        pipelineSubtitle: 'Every lead moves through the same stages, so you always know where a deal stands and what the next step is.',
        pipelineStagesNote: 'Under the hood: seven granular stages — from new lead to won or lost — with a service level per stage and overdue flags.',
        pipelineNote: 'Not every lead closes: lost deals are recorded too, so the funnel tells you the truth.',
        stageApply: 'New lead',
        stageInterview: 'Contacted',
        stageInternship: 'Proposal sent',
        stageHired: 'Won',
        moreTitle: 'And a lot more',
        moreSubtitle: 'A quick sample of what else ships out of the box.',
        more1: 'CSV import and Excel export for leads',
        more2: 'Saved views, filters and fast server-side pagination',
        more3: 'Tags to slice leads and accounts any way you like',
        more4: 'Read-only REST API with OpenAPI spec, API keys and signed webhooks',
        more5: 'Calendar with ICS feed, availability slots and meeting requests',
        more6: 'Duplicate detection and one-click merge for leads',
        more7: 'Invitation lifecycle tracking for your team (sent → opened → registered → verified)',
        more8: 'Accessibility: adjustable font size, skip links and visible focus rings',
        ctaTitle: 'Ready to see every deal in one place?',
        ctaSubtitle: 'Set up your pipeline in minutes — your team signs in with an invitation.',
        ctaMentee: 'Sign in',
        ctaFootnote: 'Open source, AGPL-3.0 — the code is on GitHub.',
        trans5T: 'Consent as a mechanism',
        trans5D: 'Customer data is shown to nobody outside your team; every consent is recorded with its version and revocable at any time. Email and phone never appear on any public page.',
        transBeta: 'And the honest part: the marketing product is in early access, built by a small team, with no customer testimonials yet. We would rather you read that here than find it out later.',
        founderBody: 'SaleVali is built and maintained by {name} — one person, in the open, on the same core that runs a mentoring platform for hundreds of people. Questions and criticism are welcome.',
        badge: 'Marketing CRM · Track leads · Close deals',
        heroTitle: 'Every lead, every conversation, every deal —',
        heroAccent: 'in one pipeline.',
        heroSubtitle: 'Track your customers from first contact to close. See where every deal stands, who touched it last and what to do next — instead of piecing it together from a spreadsheet.',
        featuresTitle: 'Everything your team needs to close',
        featuresSubtitle: 'Purpose-built for tracking customers and moving deals forward.',
      },
    },
    tr: {
      // Kişi = müşteri adayı (Lead); pipeline ilişkisi = fırsat (Deal). "Fırsat"
      // bilerek deal için ayrıldı, kişi listesi "Müşteri Adayları" oldu.
      nav: { candidates: 'Müşteri Adayları' },
      candidates: {
        title: 'Müşteri Adayları',
        subtitle: 'Müşteri adaylarını görüntüle ve ara',
        mentor: 'Temsilci',
        mineFilter: 'Benim müşterilerim',
        bulkOwnerLabel: 'Temsilci',
        bulkAssignOwner: 'Temsilci ata',
      },
      publicNav: {
        homeLink: 'SaleVali — ana sayfaya git',
        tagline: 'Müşteri adayları, firmalar ve anlaşmalar tek hatta — ilk temastan kapanışa.',
      },
      auth: {
        signinSubtitle: 'SaleVali hesabınıza giriş yapın',
        registerSubtitle: 'Davetinizle kaydolun',
        tokenHint: 'E-postanızdaki davet kodunu yapıştırın. Bu üründe hesaplar davetle açılır.',
      },
      dashboard: {
        subtitle: 'Pazarlama hattınıza genel bakış',
        mentees: 'Müşteri Adayları',
        mentors: 'Temsilciler',
        activeMentorships: 'Aktif fırsatlar',
        perStage: 'Aşama başına aday',
        recentMentorships: 'Son fırsatlar',
        latestAssignments: 'Son eklenen fırsatlar',
        noMentorships: 'Henüz fırsat yok',
        newCandidates: 'Yeni Müşteri Adayları',
        recentlyRegistered: 'Son eklenen müşteri adayları',
        noCandidates: 'Henüz müşteri adayı yok',
        quickActions: { browseCandidates: 'Müşteri adaylarını görüntüle' },
      },
      checklist: {
        steps: {
          inviteMentors: 'İlk temsilcilerini davet et',
          inviteMentees: 'İlk müşteri adaylarını ekle',
          assignMentorship: 'İlk fırsatı oluştur',
        },
      },
      companiesPage: {
        subtitle: 'Sattığın müşteri firmalarını ve ihtiyaçlarını yönet',
        addLoginHint: 'Bir şirketin kendi müşteri adaylarını izlemesi için salt-okunur giriş oluştur.',
        mentorships: 'fırsat',
        positions: 'ihtiyaç',
        openPositions: 'Açık ihtiyaçlar',
      },
      companyForm: {
        quota: 'İhtiyaç kontenjanı',
        needs: 'Firma ihtiyaçları',
        noNeeds: 'Henüz ihtiyaç eklenmedi. Bu firmanın neye ihtiyacı olduğunu kaydetmek için "İhtiyaç ekle"ye tıkla.',
      },
      entitlements: {
        subtitle: '{name} için premium özellikleri aç. Temsilci ve müşteri adayı özellikleri her zaman ücretsizdir.',
      },
      board: { emptyStage: 'Bu aşamada müşteri adayı yok' },
      adminBoard: {
        subtitle: 'Tüm temsilcilerin tüm müşteri adayları — aşamayı kartı sürükleyerek ya da kartın aşama menüsünden değiştir',
        searchPlaceholder: 'Müşteri adayı veya temsilci bul...',
        wipSaturated: 'Panodaki her sütun kendi iş limitinin üzerinde; bu yüzden turuncu uyarı artık bir yeri işaret etmiyor ve gizlendi. Bu hattın gerçekten nasıl yürüdüğüne uyan bir limit belirle — pano için tek sayı ya da aşama başına birer tane.',
        groups: { pre: 'Müşteri Adayları', internship: 'Fırsatlar', custom: 'Satış hunisi' },
      },
      personCard: { roleMentor: 'Temsilci', roleMentee: 'Müşteri adayı' },
      emptyStates: {
        board: {
          adminBody: 'Her fırsat burada, ulaştığı aşamada bir kart olarak görünür. İlk müşteri adaylarını ekle; bir temsilci sahiplendiği anda kartları burada belirir.',
        },
        companies: {
          adminBody: 'Şirketler sattığın müşteri hesaplarıdır: bir şirket eklediğinde ona ihtiyaçlarını, iletişim kişilerini ve açık fırsatlarını bağlayabilirsin.',
        },
      },
      landing: {
        chipStages: 'Adaydan kapanan anlaşmaya tek hat',
        chipRoles: 'Açık kaynak — AGPL-3.0',
        chipLangs: 'English · Türkçe · Deutsch',
        chipGdpr: 'Müşteri veriniz sizde kalır',
        fPipelineT: 'Hat takibi',
        fPipelineD: 'Her müşteri adayı tek panoda, yeniden kazanıldı ya da kaybedildiye — sürükle-bırak aşamalar, aşama başına son tarih ve gecikme işaretleri, kimin neyi ne zaman taşıdığının tam geçmişi.',
        fCompanyT: 'Firmalar & kişiler',
        fCompanyD: 'Sattığınız firmaları ve içindeki kişileri takip edin, her firmanın ihtiyacını kaydedin, açık fırsatların hepsini tek yerde görün.',
        fCommsT: 'İletişim',
        fCommsD: 'RSVP’li toplantı davetleri, her fırsatta uygulama içi mesajlaşma, tekil ve toplu e-posta, duyurular, kategori bazlı bildirim tercihleri, hatırlatmalar ve haftalık özet.',
        fDocsT: 'Belgeler & şablonlar',
        fDocsD: 'Her aday ve firmada sürümlü yüklemeler; teklif ve takip yazıları için çok dilli şablon kütüphanesi, uygulama içi önizleme ve PDF dışa aktarma.',
        fAnalyticsT: 'Analitik & içgörü',
        fAnalyticsD: 'Dönüşüm hunisi, aşama başına süre ve yaşlanma, temsilci başına fırsat ve sonuçları, tarih aralığı seçicili altı aylık eğilimler.',
        fPrivacyT: 'Erişim & gizlilik',
        fPrivacyD: 'Rol bazlı erişim, iki adımlı doğrulama, e-posta doğrulaması, etkinlik günlüğü ve tam KVKK/GDPR araç seti: onay, saklama hatırlatmaları, silme ve tek tıkla veri dışa aktarma.',
        fPlatformT: 'Çalışması keyifli bir yer',
        fPlatformD: 'Üç dil (EN/TR/DE), karanlık mod, ayarlanabilir yazı boyutu, genel arama, çevrimdışı destekli uygulama olarak kurulum (PWA) ve herkese açık “Yenilikler” sayfası.',
        pipelineTitle: 'İlk temastan kapanan anlaşmaya',
        pipelineSubtitle: 'Her aday aynı aşamalardan geçer; bir anlaşmanın nerede durduğunu ve sıradaki adımı her zaman bilirsiniz.',
        pipelineStagesNote: 'Arka planda: yeni adaydan kazanıldı ya da kaybedildiye yedi ayrıntılı aşama — aşama başına hizmet seviyesi ve gecikme işaretleri.',
        pipelineNote: 'Her aday kapanmaz: kaybedilen anlaşmalar da kaydedilir, huni size doğruyu söyler.',
        stageApply: 'Yeni aday',
        stageInterview: 'İletişime geçildi',
        stageInternship: 'Teklif gönderildi',
        stageHired: 'Kazanıldı',
        moreTitle: 'Ve çok daha fazlası',
        moreSubtitle: 'Kutudan çıkan diğer şeylerden kısa bir örnek.',
        more1: 'Adaylar için CSV içe ve Excel dışa aktarma',
        more2: 'Kayıtlı görünümler, filtreler ve hızlı sunucu taraflı sayfalama',
        more3: 'Aday ve firmaları istediğiniz gibi dilimlemek için etiketler',
        more4: 'OpenAPI şemalı salt-okunur REST API, API anahtarları ve imzalı webhook’lar',
        more5: 'ICS beslemeli takvim, uygunluk aralıkları ve toplantı talepleri',
        more6: 'Adaylarda yinelenen tespiti ve tek tıkla birleştirme',
        more7: 'Ekibiniz için davet yaşam döngüsü takibi (gönderildi → açıldı → kaydoldu → doğrulandı)',
        more8: 'Erişilebilirlik: ayarlanabilir yazı boyutu, atlama bağlantıları ve görünür odak halkaları',
        ctaTitle: 'Her anlaşmayı tek yerde görmeye hazır mısınız?',
        ctaSubtitle: 'Hattınızı dakikalar içinde kurun — ekibiniz davetle giriş yapar.',
        ctaMentee: 'Giriş yap',
        ctaFootnote: 'Açık kaynak, AGPL-3.0 — kod GitHub’da.',
        trans5T: 'Mekanizma olarak onay',
        trans5D: 'Müşteri verisi ekibiniz dışında kimseye gösterilmez; her onay sürümüyle kaydedilir ve her an geri alınabilir. E-posta ve telefon hiçbir herkese açık sayfada görünmez.',
        transBeta: 'Ve dürüst kısmı: pazarlama ürünü erken erişimde, küçük bir ekip yazıyor, henüz müşteri referansı yok. Bunu sonradan öğrenmenizden burada okumanızı tercih ederiz.',
        founderBody: 'SaleVali, yüzlerce kişiye mentorluk platformu çalıştıran aynı çekirdek üzerinde, {name} tarafından — tek kişi, açıkta — geliştiriliyor ve bakımı yapılıyor. Soru ve eleştiriye açığız.',
        badge: 'Pazarlama CRM · Adayları takip et · Anlaşmaları kapat',
        heroTitle: 'Her aday, her görüşme, her anlaşma —',
        heroAccent: 'tek bir hatta.',
        heroSubtitle: 'Müşterilerini ilk temastan kapanışa kadar takip et. Her anlaşmanın nerede olduğunu, en son kimin dokunduğunu ve sıradaki adımı — tabloda parça parça aramak yerine — tek bakışta gör.',
        featuresTitle: 'Kapatmak için ekibinin ihtiyacı olan her şey',
        featuresSubtitle: 'Müşterileri takip etmek ve anlaşmaları ilerletmek için tasarlandı.',
      },
    },
    de: {
      nav: { candidates: 'Leads' },
      candidates: {
        title: 'Leads',
        subtitle: 'Leads durchsuchen',
        mentor: 'Vertriebsmitarbeiter',
        mineFilter: 'Meine Kunden',
        bulkOwnerLabel: 'Vertriebsmitarbeiter',
        bulkAssignOwner: 'Vertriebsmitarbeiter zuweisen',
      },
      publicNav: {
        homeLink: 'SaleVali — zur Startseite',
        tagline: 'Leads, Accounts und Deals in einer Pipeline — vom ersten Kontakt bis zum Abschluss.',
      },
      auth: {
        signinSubtitle: 'Melden Sie sich bei Ihrem SaleVali-Konto an',
        registerSubtitle: 'Mit Ihrer Einladung registrieren',
        tokenHint: 'Fügen Sie den Einladungscode aus Ihrer E-Mail ein. Konten in diesem Produkt werden per Einladung angelegt.',
      },
      dashboard: {
        subtitle: 'Überblick über Ihre Marketing-Pipeline',
        mentees: 'Leads',
        mentors: 'Vertriebsmitarbeiter',
        activeMentorships: 'Aktive Deals',
        perStage: 'Leads pro Phase',
        recentMentorships: 'Aktuelle Deals',
        latestAssignments: 'Neueste Deals',
        noMentorships: 'Noch keine Deals',
        newCandidates: 'Neue Leads',
        recentlyRegistered: 'Kürzlich hinzugefügte Leads',
        noCandidates: 'Noch keine Leads',
        quickActions: { browseCandidates: 'Leads durchsuchen' },
      },
      checklist: {
        steps: {
          inviteMentors: 'Laden Sie Ihre ersten Mitarbeiter ein',
          inviteMentees: 'Fügen Sie Ihre ersten Leads hinzu',
          assignMentorship: 'Ersten Deal anlegen',
        },
      },
      companiesPage: {
        subtitle: 'Kunden-Accounts und ihren Bedarf verwalten',
        addLoginHint: 'Erstelle einen Zugang mit Lesezugriff, damit ein Unternehmen seine verknüpften Leads einsehen kann.',
        mentorships: 'Deals',
        positions: 'Bedarfe',
        openPositions: 'Offener Bedarf',
      },
      companyForm: {
        quota: 'Bedarfskontingent',
        needs: 'Bedarf des Accounts',
        noNeeds: 'Noch kein Bedarf hinzugefügt. Klicke auf "Bedarf hinzufügen", um festzuhalten, was dieser Account braucht.',
      },
      entitlements: {
        subtitle: 'Premium-Funktionen für {name} aktivieren. Funktionen für Vertriebsmitarbeiter und Leads sind immer kostenlos.',
      },
      board: { emptyStage: 'Keine Leads in dieser Phase' },
      adminBoard: {
        subtitle: 'Alle Leads aller Vertriebsmitarbeiter — ziehe eine Karte oder nutze ihr Phasenmenü, um die Phase zu ändern',
        searchPlaceholder: 'Lead oder Vertriebsmitarbeiter finden...',
        wipSaturated: 'Jede Spalte dieses Boards liegt über ihrem Arbeitslimit, damit zeigt die bernsteinfarbene Warnung nirgendwo mehr hin und wird ausgeblendet. Lege ein Limit fest, das zu dieser Pipeline passt — eine Zahl für das ganze Board oder eine je Phase.',
        groups: { pre: 'Leads', internship: 'Deals', custom: 'Funnel' },
      },
      personCard: { roleMentor: 'Vertriebsmitarbeiter', roleMentee: 'Lead' },
      emptyStates: {
        board: {
          adminBody: 'Jeder Deal erscheint hier als Karte, in der Phase, die er erreicht hat. Lege die ersten Leads an — sobald ein Vertriebsmitarbeiter sie übernimmt, taucht ihre Karte auf.',
        },
        companies: {
          adminBody: 'Unternehmen sind die Accounts, an die du verkaufst: sobald eines existiert, kannst du ihm seinen Bedarf, Ansprechpersonen und die offenen Deals zuordnen.',
        },
      },
      landing: {
        chipStages: 'Eine Pipeline vom Lead bis zum Abschluss',
        chipRoles: 'Open Source — AGPL-3.0',
        chipLangs: 'English · Türkçe · Deutsch',
        chipGdpr: 'Ihre Kundendaten bleiben Ihre',
        fPipelineT: 'Pipeline-Tracking',
        fPipelineD: 'Jeder Lead auf einem Board, von neu bis gewonnen oder verloren — Drag-and-drop-Phasen, eine Frist pro Phase mit Überfälligkeitsmarkern und eine vollständige Historie, wer was wann verschoben hat.',
        fCompanyT: 'Accounts & Kontakte',
        fCompanyD: 'Verfolgen Sie die Unternehmen, an die Sie verkaufen, und die Menschen darin, halten Sie den Bedarf jedes Accounts fest und sehen Sie jeden offenen Deal an einem Ort.',
        fCommsT: 'Kommunikation',
        fCommsD: 'Meeting-Einladungen mit RSVP, In-App-Nachrichten zu jedem Deal, Einzel- und Massen-E-Mails, Ankündigungen, Benachrichtigungseinstellungen pro Kategorie, Erinnerungen und ein Wochen-Digest.',
        fDocsT: 'Dokumente & Vorlagen',
        fDocsD: 'Versionierte Uploads zu jedem Lead oder Account, eine mehrsprachige Vorlagenbibliothek für Angebote und Nachfassen mit In-App-Vorschau und PDF-Export.',
        fAnalyticsT: 'Analytics & Einblicke',
        fAnalyticsD: 'Conversion-Funnel, Dauer und Alterung pro Phase, Deals pro Mitarbeiter und deren Ergebnisse, Sechsmonatstrends mit Zeitraumauswahl.',
        fPrivacyT: 'Zugriff & Datenschutz',
        fPrivacyD: 'Rollenbasierter Zugriff, Zwei-Faktor-Authentifizierung, E-Mail-Verifizierung, Aktivitätsprotokoll und ein vollständiges DSGVO-Toolkit: Einwilligung, Aufbewahrungserinnerungen, Löschung und Datenexport per Klick.',
        fPlatformT: 'Ein angenehmer Arbeitsplatz',
        fPlatformD: 'Drei Sprachen (EN/TR/DE), Dark Mode, anpassbare Schriftgröße, globale Suche, installierbar als App (PWA) mit Offline-Unterstützung und eine öffentliche „Neuigkeiten“-Seite.',
        pipelineTitle: 'Vom ersten Kontakt zum Abschluss',
        pipelineSubtitle: 'Jeder Lead durchläuft dieselben Phasen — Sie wissen immer, wo ein Deal steht und was der nächste Schritt ist.',
        pipelineStagesNote: 'Unter der Haube: sieben granulare Phasen — von neuer Lead bis gewonnen oder verloren — mit Service-Level pro Phase und Überfälligkeitsmarkern.',
        pipelineNote: 'Nicht jeder Lead schließt ab: Verlorene Deals werden ebenfalls erfasst, damit der Funnel die Wahrheit sagt.',
        stageApply: 'Neuer Lead',
        stageInterview: 'Kontaktiert',
        stageInternship: 'Angebot gesendet',
        stageHired: 'Gewonnen',
        moreTitle: 'Und noch viel mehr',
        moreSubtitle: 'Eine kleine Auswahl dessen, was sonst noch mitgeliefert wird.',
        more1: 'CSV-Import und Excel-Export für Leads',
        more2: 'Gespeicherte Ansichten, Filter und schnelle serverseitige Paginierung',
        more3: 'Tags, um Leads und Accounts beliebig zu gliedern',
        more4: 'Schreibgeschützte REST-API mit OpenAPI-Spezifikation, API-Schlüsseln und signierten Webhooks',
        more5: 'Kalender mit ICS-Feed, Verfügbarkeitsfenstern und Meeting-Anfragen',
        more6: 'Duplikaterkennung und Zusammenführen per Klick für Leads',
        more7: 'Einladungs-Lebenszyklus für Ihr Team (gesendet → geöffnet → registriert → verifiziert)',
        more8: 'Barrierefreiheit: anpassbare Schriftgröße, Sprunglinks und sichtbare Fokusringe',
        ctaTitle: 'Bereit, jeden Deal an einem Ort zu sehen?',
        ctaSubtitle: 'Richten Sie Ihre Pipeline in Minuten ein — Ihr Team meldet sich per Einladung an.',
        ctaMentee: 'Anmelden',
        ctaFootnote: 'Open Source, AGPL-3.0 — der Code ist auf GitHub.',
        trans5T: 'Einwilligung als Mechanismus',
        trans5D: 'Kundendaten sieht niemand außerhalb Ihres Teams; jede Einwilligung wird mit Version erfasst und ist jederzeit widerrufbar. E-Mail und Telefon erscheinen auf keiner öffentlichen Seite.',
        transBeta: 'Und der ehrliche Teil: Das Marketing-Produkt ist im Early Access, von einem kleinen Team gebaut, noch ohne Kundenstimmen. Wir möchten, dass Sie das hier lesen und nicht später erfahren.',
        founderBody: 'SaleVali wird von {name} gebaut und gepflegt — eine Person, offen, auf demselben Kern, der eine Mentoring-Plattform für Hunderte betreibt. Fragen und Kritik sind willkommen.',
        badge: 'Marketing-CRM · Leads verfolgen · Abschlüsse erzielen',
        heroTitle: 'Jeder Lead, jedes Gespräch, jeder Abschluss —',
        heroAccent: 'in einer Pipeline.',
        heroSubtitle: 'Verfolgen Sie Ihre Kunden vom ersten Kontakt bis zum Abschluss. Sehen Sie auf einen Blick, wo jeder Deal steht, wer ihn zuletzt bearbeitet hat und was als Nächstes zu tun ist — statt es aus einer Tabelle zusammenzusuchen.',
        featuresTitle: 'Alles, was Ihr Team zum Abschluss braucht',
        featuresSubtitle: 'Entwickelt, um Kunden zu verfolgen und Deals voranzutreiben.',
      },
    },
  },
};

// Is there anything to merge for this vertical+locale? Lets the caller skip the
// merge (and return the base object unchanged) for the common empty case.
function hasOverlay(vertical: VerticalKey, locale: Locale): boolean {
  return Object.keys(OVERLAYS[vertical]?.[locale] ?? {}).length > 0;
}

// Deep-merge an overlay onto a base dictionary, returning a NEW object; the base
// is never mutated (it is shared module state for the process). Only plain
// objects recurse; every leaf (string, array, number) is replaced wholesale.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, overlay: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return (overlay as unknown as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v as DeepPartial<unknown>) : v;
  }
  return out as T;
}

// Apply a vertical's overlay to an already-resolved base dictionary. Returns the
// base unchanged when the vertical overrides nothing for this locale — so the
// INTERNSHIP path and every not-yet-dressed locale cost nothing and stay
// referentially identical.
export function applyVerticalOverlay<T extends object>(
  base: T,
  locale: Locale,
  vertical: VerticalKey | null | undefined,
): T {
  const v = vertical ?? DEFAULT_VERTICAL;
  if (v === DEFAULT_VERTICAL || !hasOverlay(v, locale)) return base;
  return deepMerge(base, OVERLAYS[v][locale] as DeepPartial<T>);
}

// Exposed for two guards. scripts/check-i18n.ts (node, at the PR gate) flattens
// these to assert every overlay key already exists in the base and that
// INTERNSHIP is empty. The compile-time half is stronger and needs nothing
// here: `LocaleOverlay = DeepPartial<Dictionary>` over `typeof en` makes a
// misspelled overlay key a TS excess-property error, caught by `tsc --noEmit`
// in CI — so a typo is a build failure, and check-i18n is defence-in-depth plus
// the one thing types cannot see (a valid override wrongly placed in the empty
// INTERNSHIP entry).
export function overlayEntries(): { vertical: VerticalKey; locale: Locale; overlay: LocaleOverlay }[] {
  const out: { vertical: VerticalKey; locale: Locale; overlay: LocaleOverlay }[] = [];
  for (const vertical of Object.keys(OVERLAYS) as VerticalKey[]) {
    for (const locale of Object.keys(OVERLAYS[vertical]) as Locale[]) {
      out.push({ vertical, locale, overlay: OVERLAYS[vertical][locale] });
    }
  }
  return out;
}
