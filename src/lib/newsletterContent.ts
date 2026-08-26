import type { Locale } from '@/i18n/config';
import type { NewsletterAudience, NewsletterIssueContent } from '@/lib/newsletter';

/**
 * The curated newsletter library (#1469) — ready-to-send issues in EN/TR/DE.
 *
 * WHY THE CONTENT SHIPS IN THE REPO
 *
 * A newsletter module with an empty composer never sends a newsletter. Whoever
 * opens `/admin/newsletters` on a Tuesday afternoon does not have three
 * languages of career advice in their head, and "we will write it later" is how
 * the feature dies. So the library ships filled: pick an issue, adjust a line,
 * schedule it.
 *
 * These are also a house style, not filler. Every entry follows the same rules,
 * and a new one should too:
 *
 *   - One idea per issue. "CV tips" is not an idea; "your CV gets six seconds"
 *     is.
 *   - Three to four tips, each an emoji + a heading you could act on + one or
 *     two sentences. If a tip needs a paragraph, it is its own issue.
 *   - Concrete over motivational. "Verb + what + effect" beats "believe in
 *     yourself"; a reader who does one small thing after reading opens the next
 *     one.
 *   - An `action` that fits in ten minutes tonight.
 *   - `mentorNote` only where a mentor genuinely has a different job to do with
 *     the same content — that is what makes an issue `BOTH` rather than two
 *     issues.
 *
 * Editing an entry here does NOT change an issue that was already created from
 * it: `POST /api/admin/newsletters` copies the content into the row. The
 * `templateKey` on that row is provenance only.
 */

export type NewsletterTopic = 'cv' | 'interview' | 'profile' | 'search' | 'internship';

export interface NewsletterTemplate {
  key: string;
  topic: NewsletterTopic;
  audience: NewsletterAudience;
  /** Shown in the admin picker so the library is scannable, like the issues are. */
  emoji: string;
  /** Every template is written in all three languages — the picker promises that. */
  content: Record<Locale, NewsletterIssueContent>;
}

export const NEWSLETTER_TEMPLATES: NewsletterTemplate[] = [
  {
    key: 'cv-first-six-seconds',
    topic: 'cv',
    audience: 'BOTH',
    emoji: '📄',
    content: {
      en: {
        subject: 'Your CV gets six seconds. Spend them well.',
        preheader: 'Three fixes that make a recruiter keep reading.',
        intro: 'Nobody reads a CV top to bottom on the first pass. They scan it for six seconds, decide, and only then read. These three fixes are for those six seconds.',
        tips: [
          { emoji: '👀', title: 'The top third decides everything', body: 'Your name, the role you want, and three lines of proof. If your best achievement is on page two, it does not exist.' },
          { emoji: '✂️', title: 'One page until you have five years', body: 'Cut the course projects that taught you nothing, the "MS Office" line, and the photo if you are applying abroad.' },
          { emoji: '🔍', title: "Mirror the job ad's words", body: 'If the ad says "React", your CV should not say "modern JS frameworks". Filters and humans both search for the exact word.' },
        ],
        action: 'Open your CV, cover everything below the first third, and ask: would I call this person?',
        mentorNote: 'On your next call, do the six-second test out loud: look at your mentee\'s CV for six seconds, then say what you remember. Whatever you cannot recall is what needs to move up.',
      },
      tr: {
        subject: "CV'nin altı saniyesi var. İyi harca.",
        preheader: 'Okumaya devam ettiren üç düzeltme.',
        intro: 'Hiç kimse bir CV\'yi ilk seferde baştan sona okumaz. Altı saniye tarar, kararını verir, sonra okur. Bu üç düzeltme o altı saniye için.',
        tips: [
          { emoji: '👀', title: 'Her şeyi ilk üçte bir belirler', body: 'Adın, hedeflediğin pozisyon ve üç satır kanıt. En iyi başarın ikinci sayfadaysa yok sayılır.' },
          { emoji: '✂️', title: 'Beş yıl deneyime kadar tek sayfa', body: 'Sana hiçbir şey öğretmeyen ders projelerini, "MS Office" satırını ve yurt dışına başvuruyorsan fotoğrafı çıkar.' },
          { emoji: '🔍', title: 'İlanın kelimelerini kullan', body: 'İlan "React" diyorsa CV\'nde "modern JS kütüphaneleri" yazmasın. Hem filtreler hem insanlar tam kelimeyi arıyor.' },
        ],
        action: "CV'ni aç, ilk üçte birin altını elinle kapat ve sor: bu kişiyi arar mıydım?",
        mentorNote: 'Bir sonraki görüşmede altı saniye testini sesli yap: mentee\'nin CV\'sine altı saniye bak, sonra hatırladıklarını söyle. Hatırlamadığın şey yukarı taşınmalı.',
      },
      de: {
        subject: 'Dein CV hat sechs Sekunden. Nutze sie.',
        preheader: 'Drei Korrekturen, nach denen weitergelesen wird.',
        intro: 'Niemand liest einen CV beim ersten Mal von oben bis unten. Sechs Sekunden überfliegen, entscheiden, dann lesen. Diese drei Korrekturen gelten für diese sechs Sekunden.',
        tips: [
          { emoji: '👀', title: 'Das obere Drittel entscheidet', body: 'Name, Zielposition und drei Zeilen Beweis. Wenn deine beste Leistung auf Seite zwei steht, existiert sie nicht.' },
          { emoji: '✂️', title: 'Eine Seite, bis du fünf Jahre Erfahrung hast', body: 'Streiche Uni-Projekte ohne Lerneffekt und die Zeile "MS-Office-Kenntnisse".' },
          { emoji: '🔍', title: 'Übernimm die Wörter der Anzeige', body: 'Steht "React" in der Anzeige, schreibe nicht "moderne JS-Frameworks". Filter und Menschen suchen genau dieses Wort.' },
        ],
        action: 'Öffne dein CV, decke alles unter dem oberen Drittel ab und frage: Würde ich diese Person anrufen?',
        mentorNote: 'Mach den Sechs-Sekunden-Test im nächsten Gespräch laut: sechs Sekunden auf den CV schauen, dann sagen, was du behalten hast. Was du nicht erinnerst, muss nach oben.',
      },
    },
  },
  {
    key: 'cv-impact-bullets',
    topic: 'cv',
    audience: 'MENTEE',
    emoji: '🎯',
    content: {
      en: {
        subject: 'Write results, not duties',
        preheader: 'The three-part bullet that turns a task list into evidence.',
        intro: 'Most CV bullets describe a job description. Recruiters already know what a job involves — what they cannot guess is what changed because you were there.',
        tips: [
          { emoji: '🧩', title: 'Verb + what + effect', body: '"Rewrote the checkout form; drop-offs fell from 40% to 24%." Same length as "Responsible for forms", ten times the information.' },
          { emoji: '🔢', title: 'A number, even a small one', body: 'Two users, three weeks, 12 tests. Small real numbers beat "significantly improved" every time.' },
          { emoji: '🙋', title: 'Say "I", not "we"', body: 'In a team project, name your part. "We built an app" tells the reader nothing about you.' },
        ],
        action: 'Rewrite two bullets tonight using verb + what + effect. Two is enough.',
      },
      tr: {
        subject: 'Görev değil, sonuç yaz',
        preheader: 'Görev listesini kanıta çeviren üç parçalı madde.',
        intro: 'CV maddelerinin çoğu iş tanımını anlatır. İşe alım uzmanı o işin ne olduğunu biliyor; tahmin edemediği şey sen orada olduğun için neyin değiştiği.',
        tips: [
          { emoji: '🧩', title: 'Fiil + ne + etki', body: '"Ödeme formunu yeniden yazdım; terk oranı %40\'tan %24\'e düştü." "Formlardan sorumluydum" ile aynı uzunluk, on kat bilgi.' },
          { emoji: '🔢', title: 'Küçük de olsa bir sayı', body: 'İki kullanıcı, üç hafta, 12 test. Küçük ama gerçek sayılar "önemli ölçüde geliştirdim"i her zaman yener.' },
          { emoji: '🙋', title: '"Biz" değil "ben" yaz', body: 'Takım projesinde kendi payını söyle. "Bir uygulama geliştirdik" okuyucuya senin hakkında hiçbir şey anlatmaz.' },
        ],
        action: 'Bu akşam iki maddeyi fiil + ne + etki kalıbıyla yeniden yaz. İki tane yeter.',
      },
      de: {
        subject: 'Schreibe Ergebnisse, keine Aufgaben',
        preheader: 'Der dreiteilige Stichpunkt, der aus einer Aufgabenliste einen Beweis macht.',
        intro: 'Die meisten CV-Stichpunkte beschreiben eine Stellenbeschreibung. Was in einem Job zu tun ist, weiß die Recruiterin schon — nicht, was sich geändert hat, weil du dort warst.',
        tips: [
          { emoji: '🧩', title: 'Verb + was + Wirkung', body: '"Checkout-Formular neu gebaut; Abbrüche von 40 % auf 24 % gesenkt." Gleich lang wie "Zuständig für Formulare", zehnmal so viel Inhalt.' },
          { emoji: '🔢', title: 'Eine Zahl, auch eine kleine', body: 'Zwei Nutzer, drei Wochen, 12 Tests. Kleine echte Zahlen schlagen "deutlich verbessert" immer.' },
          { emoji: '🙋', title: 'Schreibe "ich", nicht "wir"', body: 'Nenne im Teamprojekt deinen Anteil. "Wir haben eine App gebaut" sagt nichts über dich.' },
        ],
        action: 'Schreibe heute Abend zwei Stichpunkte um: Verb + was + Wirkung. Zwei genügen.',
      },
    },
  },
  {
    key: 'interview-star',
    topic: 'interview',
    audience: 'BOTH',
    emoji: '🎤',
    content: {
      en: {
        subject: 'The STAR answer, in 90 seconds',
        preheader: 'Situation, task, action, result — and where most answers go wrong.',
        intro: '"Tell me about a time you…" is not a memory test. It checks whether you can tell a story with a point. Ninety seconds, four parts.',
        tips: [
          { emoji: '🗺️', title: 'Twenty seconds of setup, maximum', body: 'Where, when, what was at stake. Interviewers get lost in a long setup and stop listening before you reach what you did.' },
          { emoji: '🛠️', title: 'Spend the middle on YOUR action', body: 'This is the part being scored. "I did X because Y" — the "because" is where your judgement shows.' },
          { emoji: '🏁', title: 'Always land the result', body: 'Even a bad one, if you name the lesson. An answer with no ending sounds like a story you are still inside.' },
        ],
        action: 'Pick one story from the last year and time yourself telling it. Over two minutes? Cut the setup.',
        mentorNote: 'Run one mock question per session and do nothing but time it. Most mentees do not need better stories — they need to hear that the setup ate 60 of their 90 seconds.',
      },
      tr: {
        subject: '90 saniyede STAR cevabı',
        preheader: 'Durum, görev, eylem, sonuç — ve cevapların çoğunun nerede dağıldığı.',
        intro: '"Bir zamanı anlat…" sorusu hafıza testi değil. Bir hikâyeyi bir noktaya bağlayabiliyor musun diye bakılıyor. Doksan saniye, dört parça.',
        tips: [
          { emoji: '🗺️', title: 'Kurulum en fazla yirmi saniye', body: 'Nerede, ne zaman, ne risk vardı. Uzun kurulumda dinleyici kaybolur ve sen ne yaptığına gelmeden dinlemeyi bırakır.' },
          { emoji: '🛠️', title: 'Ortayı KENDİ eylemine ayır', body: 'Puanlanan kısım burası. "X\'i yaptım çünkü Y" — "çünkü" kısmı muhakemeni gösteriyor.' },
          { emoji: '🏁', title: 'Sonucu mutlaka söyle', body: 'Kötü sonuç bile olur, dersini söylersen. Sonu olmayan cevap, içinden hâlâ çıkamadığın bir hikâye gibi duyulur.' },
        ],
        action: 'Son bir yıldan bir hikâye seç ve anlatırken süre tut. İki dakikayı geçtiyse kurulumu kısalt.',
        mentorNote: 'Her görüşmede tek bir deneme sorusu sor ve sadece süre tut. Mentee\'lerin çoğunun daha iyi hikâyeye ihtiyacı yok; 90 saniyenin 60\'ını kurulumun yediğini duymaya ihtiyacı var.',
      },
      de: {
        subject: 'Die STAR-Antwort in 90 Sekunden',
        preheader: 'Situation, Aufgabe, Handlung, Ergebnis — und wo die meisten Antworten kippen.',
        intro: '"Erzähl von einer Situation, in der…" ist kein Gedächtnistest. Geprüft wird, ob du eine Geschichte mit Pointe erzählen kannst. Neunzig Sekunden, vier Teile.',
        tips: [
          { emoji: '🗺️', title: 'Höchstens zwanzig Sekunden Vorlauf', body: 'Wo, wann, was stand auf dem Spiel. Bei langem Vorlauf hören die meisten auf zuzuhören, bevor du bei deiner Handlung bist.' },
          { emoji: '🛠️', title: 'Die Mitte gehört DEINER Handlung', body: 'Das ist der bewertete Teil. "Ich habe X gemacht, weil Y" — im "weil" zeigt sich dein Urteilsvermögen.' },
          { emoji: '🏁', title: 'Bring immer das Ergebnis', body: 'Auch ein schlechtes, wenn du die Lehre nennst. Eine Antwort ohne Ende klingt wie eine Geschichte, in der du noch steckst.' },
        ],
        action: 'Wähle eine Geschichte aus dem letzten Jahr und nimm die Zeit, während du sie erzählst. Über zwei Minuten? Kürze den Vorlauf.',
        mentorNote: 'Stelle pro Termin eine Übungsfrage und mach nichts außer Zeit nehmen. Die meisten Mentees brauchen keine besseren Geschichten — sie müssen hören, dass der Vorlauf 60 von 90 Sekunden gefressen hat.',
      },
    },
  },
  {
    key: 'interview-tell-me-about-yourself',
    topic: 'interview',
    audience: 'MENTEE',
    emoji: '💬',
    content: {
      en: {
        subject: '"Tell me about yourself" is not a biography',
        preheader: 'A 45-second answer in three moves.',
        intro: 'It is the first question in almost every interview and the one people prepare least. Do not start with where you were born. Three moves, forty-five seconds.',
        tips: [
          { emoji: '📍', title: 'Now', body: 'One sentence on what you do today: "I am a final-year computer engineering student, mostly building web backends."' },
          { emoji: '🧵', title: 'The thread', body: 'Two sentences on how you got here — the one project or moment that explains your direction, not your whole timeline.' },
          { emoji: '🎯', title: 'Why this room', body: 'One sentence tying you to THIS role. Without it the answer is a monologue; with it, it is an application.' },
        ],
        action: 'Write your three sentences in a notes app and say them out loud twice. That is the whole preparation.',
      },
      tr: {
        subject: '"Kendinden bahset" bir biyografi değil',
        preheader: 'Üç hamlede 45 saniyelik cevap.',
        intro: 'Neredeyse her mülakatın ilk sorusu ve en az hazırlanılan soru. Nerede doğduğunla başlama. Üç hamle, kırk beş saniye.',
        tips: [
          { emoji: '📍', title: 'Şimdi', body: 'Bugün ne yaptığın, tek cümle: "Son sınıf bilgisayar mühendisliği öğrencisiyim, ağırlıklı olarak web backend yazıyorum."' },
          { emoji: '🧵', title: 'Bağlantı', body: 'Buraya nasıl geldiğin, iki cümle — tüm kronoloji değil, yönünü açıklayan tek proje ya da an.' },
          { emoji: '🎯', title: 'Neden bu oda', body: 'Seni BU pozisyona bağlayan tek cümle. O olmadan cevap bir monolog; onunla bir başvuru.' },
        ],
        action: 'Üç cümleni not uygulamasına yaz ve iki kez sesli söyle. Hazırlığın tamamı bu.',
      },
      de: {
        subject: '"Erzähl von dir" ist keine Biografie',
        preheader: 'Eine Antwort in 45 Sekunden, drei Schritte.',
        intro: 'Die erste Frage in fast jedem Gespräch — und die, auf die sich am wenigsten vorbereitet wird. Fang nicht mit deinem Geburtsort an. Drei Schritte, fünfundvierzig Sekunden.',
        tips: [
          { emoji: '📍', title: 'Jetzt', body: 'Ein Satz zu heute: "Ich studiere Informatik im letzten Jahr und baue vor allem Web-Backends."' },
          { emoji: '🧵', title: 'Der Faden', body: 'Zwei Sätze dazu, wie du hierher kamst — das eine Projekt, das deine Richtung erklärt, nicht der ganze Lebenslauf.' },
          { emoji: '🎯', title: 'Warum dieser Raum', body: 'Ein Satz, der dich mit DIESER Stelle verbindet. Ohne ihn ist die Antwort ein Monolog, mit ihm eine Bewerbung.' },
        ],
        action: 'Schreibe deine drei Sätze in eine Notiz-App und sprich sie zweimal laut. Das ist die ganze Vorbereitung.',
      },
    },
  },
  {
    key: 'interview-your-questions',
    topic: 'interview',
    audience: 'MENTEE',
    emoji: '❓',
    content: {
      en: {
        subject: 'The questions YOU ask are part of the interview',
        preheader: 'Three that make an interviewer sit up — and one to never ask.',
        intro: '"Do you have any questions?" is still the interview. A good question shows you were listening and thinking about the work, not just the offer.',
        tips: [
          { emoji: '🔬', title: '"What does the first month look like for the person you hire?"', body: 'Concrete and forward-looking, and the answer tells you whether they have thought about you at all.' },
          { emoji: '🧯', title: '"What is the hardest part of this team\'s work right now?"', body: 'Invites an honest answer and gives you something real to react to.' },
          { emoji: '📈', title: '"How will we know in six months that this went well?"', body: 'Shows you think in outcomes. Also: the answer is your future performance review.' },
          { emoji: '🚫', title: 'Skip "what does your company do?"', body: 'It is on the website. Asking it says you did not read it.' },
        ],
        action: 'Save two of these in your phone notes before your next call. Reading them off the screen is completely fine.',
      },
      tr: {
        subject: 'SENİN sorduğun sorular da mülakatın parçası',
        preheader: 'Karşındakini doğrultan üç soru — ve asla sorulmayacak bir tane.',
        intro: '"Sormak istediğin bir şey var mı?" hâlâ mülakat. İyi bir soru, teklifi değil işi düşündüğünü ve dinlediğini gösterir.',
        tips: [
          { emoji: '🔬', title: '"İşe alacağınız kişinin ilk ayı nasıl geçiyor?"', body: 'Somut ve ileriye dönük; cevabı sana onların seni hiç düşünüp düşünmediğini söyler.' },
          { emoji: '🧯', title: '"Bu ekibin şu anki en zor işi ne?"', body: 'Dürüst cevaba kapı açar ve sana tepki verebileceğin gerçek bir şey verir.' },
          { emoji: '📈', title: '"Altı ay sonra bunun iyi gittiğini nasıl anlarız?"', body: 'Sonuç odaklı düşündüğünü gösterir. Ayrıca cevap, gelecekteki performans değerlendirmen.' },
          { emoji: '🚫', title: '"Şirketiniz ne iş yapıyor?" sorusunu sorma', body: 'Cevabı sitede. Sormak, okumadığını söylüyor.' },
        ],
        action: 'Bir sonraki görüşmeden önce bunlardan ikisini telefonuna not al. Ekrandan okumanın hiçbir sakıncası yok.',
      },
      de: {
        subject: 'Deine Fragen sind Teil des Gesprächs',
        preheader: 'Drei, die aufhorchen lassen — und eine, die du nie stellst.',
        intro: '"Haben Sie noch Fragen?" ist immer noch das Gespräch. Eine gute Frage zeigt, dass du zugehört und über die Arbeit nachgedacht hast, nicht nur über das Angebot.',
        tips: [
          { emoji: '🔬', title: '"Wie sieht der erste Monat für die eingestellte Person aus?"', body: 'Konkret und nach vorn gerichtet; die Antwort zeigt, ob man dort über dich nachgedacht hat.' },
          { emoji: '🧯', title: '"Was ist gerade die schwierigste Aufgabe im Team?"', body: 'Lädt zu einer ehrlichen Antwort ein und gibt dir etwas Echtes, worauf du reagieren kannst.' },
          { emoji: '📈', title: '"Woran merken wir in sechs Monaten, dass es gut gelaufen ist?"', body: 'Zeigt, dass du in Ergebnissen denkst. Die Antwort ist außerdem deine künftige Bewertung.' },
          { emoji: '🚫', title: 'Frag nicht "Was macht Ihr Unternehmen?"', body: 'Das steht auf der Website. Die Frage sagt, dass du sie nicht gelesen hast.' },
        ],
        action: 'Speichere zwei davon vor dem nächsten Gespräch in deinen Notizen. Vom Bildschirm ablesen ist völlig in Ordnung.',
      },
    },
  },
  {
    key: 'linkedin-tune-up',
    topic: 'profile',
    audience: 'MENTEE',
    emoji: '🔗',
    content: {
      en: {
        subject: 'Twenty minutes on your LinkedIn profile',
        preheader: 'Photo, headline, one paragraph. Nothing else today.',
        intro: 'Recruiters search LinkedIn before they open your CV. You do not need a perfect profile — you need three fields that are not empty.',
        tips: [
          { emoji: '🖼️', title: 'A plain photo beats no photo', body: 'Daylight, plain wall, phone camera, no sunglasses. Profiles with a photo get opened far more often.' },
          { emoji: '🏷️', title: 'Headline = role + tool + place', body: '"Computer engineering student · Python & SQL · Istanbul" works. "Passionate about technology" does not.' },
          { emoji: '📝', title: 'Four lines in About', body: 'What you study, what you can already do, what you are looking for, how to reach you. Four lines, plain words.' },
        ],
        action: 'Set a 20-minute timer and fix only those three fields. Skip everything else.',
      },
      tr: {
        subject: 'LinkedIn profiline yirmi dakika',
        preheader: 'Fotoğraf, başlık, bir paragraf. Bugün başka bir şey yok.',
        intro: 'İşe alım uzmanları CV\'ni açmadan önce LinkedIn\'de arıyor. Kusursuz bir profile ihtiyacın yok; boş olmayan üç alana ihtiyacın var.',
        tips: [
          { emoji: '🖼️', title: 'Sade bir fotoğraf, fotoğrafsızı yener', body: 'Gün ışığı, düz duvar, telefon kamerası, güneş gözlüğü yok. Fotoğraflı profiller belirgin şekilde daha çok açılıyor.' },
          { emoji: '🏷️', title: 'Başlık = pozisyon + araç + şehir', body: '"Bilgisayar mühendisliği öğrencisi · Python & SQL · İstanbul" işe yarar. "Teknoloji tutkunu" yaramaz.' },
          { emoji: '📝', title: 'Hakkında bölümüne dört satır', body: 'Ne okuduğun, şu an neyi yapabildiğin, ne aradığın, sana nasıl ulaşılacağı. Dört satır, sade kelimeler.' },
        ],
        action: 'Yirmi dakikalık bir sayaç kur ve sadece bu üç alanı düzelt. Gerisine hiç bakma.',
      },
      de: {
        subject: 'Zwanzig Minuten für dein LinkedIn-Profil',
        preheader: 'Foto, Headline, ein Absatz. Heute nichts weiter.',
        intro: 'Recruiterinnen suchen auf LinkedIn, bevor sie deinen CV öffnen. Du brauchst kein perfektes Profil — du brauchst drei Felder, die nicht leer sind.',
        tips: [
          { emoji: '🖼️', title: 'Ein schlichtes Foto schlägt kein Foto', body: 'Tageslicht, glatte Wand, Handykamera, keine Sonnenbrille. Profile mit Foto werden deutlich häufiger geöffnet.' },
          { emoji: '🏷️', title: 'Headline = Rolle + Werkzeug + Ort', body: '"Informatikstudentin · Python & SQL · Berlin" funktioniert. "Technikbegeistert" nicht.' },
          { emoji: '📝', title: 'Vier Zeilen im Info-Feld', body: 'Was du studierst, was du schon kannst, was du suchst, wie man dich erreicht. Vier Zeilen, einfache Wörter.' },
        ],
        action: 'Stell einen Timer auf 20 Minuten und korrigiere nur diese drei Felder. Alles andere lässt du.',
      },
    },
  },
  {
    key: 'portfolio-three-projects',
    topic: 'profile',
    audience: 'MENTEE',
    emoji: '💻',
    content: {
      en: {
        subject: 'Your portfolio fits in three projects',
        preheader: 'Depth beats a long list — and a README beats both.',
        intro: 'Twelve half-finished repositories say less than three finished ones. Pick three, make them legible, and let the rest sit quietly.',
        tips: [
          { emoji: '📖', title: 'The README is the project', body: 'What it does, one screenshot, how to run it. A reviewer who cannot run it in two minutes will not read the code.' },
          { emoji: '🧪', title: 'One project with tests', body: 'Even five tests. It is the fastest way to look like someone who has worked on a team.' },
          { emoji: '🧹', title: 'Pin three, hide the rest', body: 'A pinned repository says "look here". Twenty unpinned experiments say "good luck".' },
        ],
        action: 'Write or rewrite one README today. One paragraph, one screenshot, one run command.',
      },
      tr: {
        subject: 'Portföyün üç projeye sığar',
        preheader: 'Derinlik uzun listeyi yener — README ikisini de.',
        intro: 'Yarım kalmış on iki depo, bitmiş üç depodan daha az şey anlatır. Üç tane seç, okunur hale getir, gerisi sessizce dursun.',
        tips: [
          { emoji: '📖', title: 'README projenin kendisi', body: 'Ne yaptığı, bir ekran görüntüsü, nasıl çalıştırıldığı. İki dakikada çalıştıramayan kişi kodunu okumaz.' },
          { emoji: '🧪', title: 'Testi olan bir proje', body: 'Beş test bile olur. Ekipte çalışmış biri gibi görünmenin en hızlı yolu.' },
          { emoji: '🧹', title: 'Üç tanesini sabitle, gerisini geri çek', body: 'Sabitlenmiş depo "buraya bak" der. Yirmi dağınık deneme "kolay gelsin" der.' },
        ],
        action: 'Bugün bir README yaz ya da yeniden yaz. Bir paragraf, bir ekran görüntüsü, bir çalıştırma komutu.',
      },
      de: {
        subject: 'Dein Portfolio passt in drei Projekte',
        preheader: 'Tiefe schlägt eine lange Liste — und ein README schlägt beides.',
        intro: 'Zwölf halbfertige Repositories sagen weniger als drei fertige. Wähle drei aus, mach sie lesbar, und lass den Rest ruhen.',
        tips: [
          { emoji: '📖', title: 'Das README ist das Projekt', body: 'Was es tut, ein Screenshot, wie man es startet. Wer es nicht in zwei Minuten starten kann, liest den Code nicht.' },
          { emoji: '🧪', title: 'Ein Projekt mit Tests', body: 'Auch fünf Tests reichen. Nichts lässt dich schneller wie jemanden wirken, der im Team gearbeitet hat.' },
          { emoji: '🧹', title: 'Drei anpinnen, den Rest zurückstellen', body: 'Ein angepinntes Repository sagt "schau hier". Zwanzig Experimente sagen "viel Glück".' },
        ],
        action: 'Schreib heute ein README neu. Ein Absatz, ein Screenshot, ein Startbefehl.',
      },
    },
  },
  {
    key: 'follow-up-24-hours',
    topic: 'search',
    audience: 'MENTEE',
    emoji: '✉️',
    content: {
      en: {
        subject: 'The 24 hours after an interview',
        preheader: 'A four-line note that costs nothing and gets remembered.',
        intro: 'Most candidates send nothing after an interview. A short, specific note the next morning is free — and it is the last thing on the interviewer\'s screen while they write their notes.',
        tips: [
          { emoji: '⏱️', title: 'Send it the next morning', body: 'The same day can look automated; three days later the decision may already be made.' },
          { emoji: '🔗', title: 'Name one thing from the conversation', body: '"The migration problem you described" proves you were there. A generic thank-you proves nothing.' },
          { emoji: '✍️', title: 'Four lines, no attachments', body: 'Thanks, the one thing, one sentence on why you still want it, done. Do not re-send your CV.' },
        ],
        action: 'Draft the four lines now, while the conversation is fresh, and schedule them for tomorrow morning.',
      },
      tr: {
        subject: 'Mülakattan sonraki 24 saat',
        preheader: 'Hiçbir maliyeti olmayan, akılda kalan dört satır.',
        intro: 'Adayların çoğu mülakattan sonra hiçbir şey göndermez. Ertesi sabah gönderilen kısa ve somut bir not bedava; ve karşı taraf notlarını yazarken ekranındaki son şey o oluyor.',
        tips: [
          { emoji: '⏱️', title: 'Ertesi sabah gönder', body: 'Aynı gün otomatik görünebilir; üç gün sonra karar çoktan verilmiş olabilir.' },
          { emoji: '🔗', title: 'Konuşmadan tek bir şeyi an', body: '"Anlattığınız veri taşıma problemi" orada olduğunu kanıtlar. Genel bir teşekkür hiçbir şey kanıtlamaz.' },
          { emoji: '✍️', title: 'Dört satır, ek dosya yok', body: 'Teşekkür, o tek şey, neden hâlâ istediğine dair bir cümle, bitti. CV\'yi tekrar gönderme.' },
        ],
        action: 'Dört satırı konuşma tazeyken şimdi yaz ve yarın sabaha zamanla.',
      },
      de: {
        subject: 'Die 24 Stunden nach dem Gespräch',
        preheader: 'Vier Zeilen, die nichts kosten und im Kopf bleiben.',
        intro: 'Die meisten Bewerber melden sich nach einem Gespräch nicht mehr. Eine kurze, konkrete Nachricht am nächsten Morgen ist kostenlos — und das Letzte auf dem Bildschirm, während die Notizen geschrieben werden.',
        tips: [
          { emoji: '⏱️', title: 'Schick sie am nächsten Morgen', body: 'Am selben Tag wirkt es schnell automatisiert, nach drei Tagen ist die Entscheidung oft gefallen.' },
          { emoji: '🔗', title: 'Nenne eine Sache aus dem Gespräch', body: '"Das Migrationsproblem, das Sie beschrieben haben" beweist, dass du dabei warst. Ein allgemeines Danke beweist nichts.' },
          { emoji: '✍️', title: 'Vier Zeilen, keine Anhänge', body: 'Danke, die eine Sache, ein Satz, warum du es weiter willst — fertig. Schick deinen CV nicht erneut.' },
        ],
        action: 'Schreib die vier Zeilen jetzt, solange das Gespräch frisch ist, und plane sie für morgen früh.',
      },
    },
  },
  {
    key: 'first-week-internship',
    topic: 'internship',
    audience: 'BOTH',
    emoji: '🚀',
    content: {
      en: {
        subject: 'The first week of an internship',
        preheader: 'What to do when nobody has given you a task yet.',
        intro: 'The first week feels like waiting. It is not: it is the week that decides what people will assume about you for the next three months.',
        tips: [
          { emoji: '📓', title: 'Write down every name and every tool', body: 'You will be told forty things in five days. The notebook is what stops you asking the same question twice.' },
          { emoji: '🙋', title: 'Ask after 30 minutes of being stuck', body: 'Sooner is annoying, later is expensive. Say what you already tried — that turns "I am stuck" into a good question.' },
          { emoji: '🧊', title: 'Ship one tiny thing in week one', body: 'A typo fix, a line of docs, one test. Something with your name on it beats a week of reading.' },
        ],
        action: 'Book a 15-minute call with whoever reviews your work and ask what "good" looks like to them.',
        mentorNote: 'Ask your mentee what they shipped in week one, however small. If the answer is "still reading", they need a task rather than more onboarding — and that is usually a call you can make for them.',
      },
      tr: {
        subject: 'Stajın ilk haftası',
        preheader: 'Henüz kimse sana iş vermemişken ne yapılır.',
        intro: 'İlk hafta beklemek gibi gelir; değil. Sonraki üç ay boyunca insanların senin hakkında ne varsayacağına bu hafta karar veriliyor.',
        tips: [
          { emoji: '📓', title: 'Her ismi ve her aracı yaz', body: 'Beş günde sana kırk şey söylenecek. Aynı soruyu iki kez sormanı engelleyen şey o defter.' },
          { emoji: '🙋', title: '30 dakika tıkandıysan sor', body: 'Daha erkeni rahatsız edici, daha geci pahalı. Ne denediğini söyle — "tıkandım" böylece iyi bir soruya dönüşür.' },
          { emoji: '🧊', title: 'İlk hafta küçücük bir şey teslim et', body: 'Bir yazım hatası, bir dokümantasyon satırı, bir test. Adının geçtiği bir şey, bir haftalık okumadan iyidir.' },
        ],
        action: 'İşini gözden geçiren kişiyle 15 dakikalık bir görüşme ayarla ve onun için "iyi"nin neye benzediğini sor.',
        mentorNote: 'Mentee\'ne ilk haftada ne teslim ettiğini sor, ne kadar küçük olursa olsun. Cevap "hâlâ okuyorum" ise ihtiyacı olan şey daha fazla oryantasyon değil, bir görev — ve bu genelde senin yapabileceğin bir telefon görüşmesi.',
      },
      de: {
        subject: 'Die erste Woche im Praktikum',
        preheader: 'Was du tust, wenn dir noch niemand eine Aufgabe gegeben hat.',
        intro: 'Die erste Woche fühlt sich wie Warten an. Ist sie nicht: In dieser Woche entscheidet sich, was man die nächsten drei Monate über dich annimmt.',
        tips: [
          { emoji: '📓', title: 'Schreib jeden Namen und jedes Werkzeug auf', body: 'In fünf Tagen hörst du vierzig Dinge. Das Notizbuch verhindert, dass du dieselbe Frage zweimal stellst.' },
          { emoji: '🙋', title: 'Frag nach 30 Minuten Feststecken', body: 'Früher nervt, später wird teuer. Sag, was du schon versucht hast — daraus wird aus "ich komme nicht weiter" eine gute Frage.' },
          { emoji: '🧊', title: 'Liefere in Woche eins etwas Winziges', body: 'Ein Tippfehler, eine Doku-Zeile, ein Test. Etwas mit deinem Namen ist mehr als eine Woche Lesen.' },
        ],
        action: 'Vereinbare 15 Minuten mit der Person, die deine Arbeit prüft, und frage, was für sie "gut" heißt.',
        mentorNote: 'Frag deinen Mentee, was er in Woche eins geliefert hat, egal wie klein. Lautet die Antwort "ich lese noch", braucht er eine Aufgabe und kein weiteres Onboarding — dieser Anruf ist meist einer, den du übernehmen kannst.',
      },
    },
  },
  {
    key: 'cold-outreach',
    topic: 'search',
    audience: 'MENTEE',
    emoji: '🤝',
    content: {
      en: {
        subject: 'How to write a cold message that gets answered',
        preheader: 'Five lines, one ask, no CV attached.',
        intro: 'A cold message is not a request for a favour; it is a small, easy question. The ones that get answered are short, specific, and ask for exactly one thing.',
        tips: [
          { emoji: '🎯', title: 'Say why THEM', body: 'One line proving you looked: their talk, their team, their post. Without it the message reads as sent to two hundred people.' },
          { emoji: '🪶', title: 'Ask something answerable in one reply', body: '"Is this internship still open?" gets an answer. "Can you mentor me?" gets silence.' },
          { emoji: '📎', title: 'No attachment in the first message', body: 'One link, at most. Attachments in a first message get filtered before a human sees them.' },
        ],
        action: 'Send one message today. One is a habit; twenty at once is a spam folder.',
      },
      tr: {
        subject: 'Cevap alan soğuk mesaj nasıl yazılır',
        preheader: 'Beş satır, tek bir istek, CV eki yok.',
        intro: 'Soğuk mesaj bir iyilik talebi değil; küçük ve kolay bir soru. Cevap alanlar kısa, somut ve tek bir şey isteyenler.',
        tips: [
          { emoji: '🎯', title: 'Neden o kişi olduğunu söyle', body: 'Baktığını kanıtlayan tek satır: konuşması, ekibi, paylaşımı. O olmadan mesaj iki yüz kişiye gönderilmiş gibi okunur.' },
          { emoji: '🪶', title: 'Tek yanıtla cevaplanabilecek bir şey sor', body: '"Bu staj hâlâ açık mı?" cevap alır. "Bana mentorluk yapar mısınız?" sessizlik alır.' },
          { emoji: '📎', title: 'İlk mesajda ek dosya yok', body: 'En fazla bir bağlantı. İlk mesajdaki ekler, bir insan görmeden filtreye takılır.' },
        ],
        action: 'Bugün bir mesaj gönder. Bir tanesi alışkanlıktır; aynı anda yirmi tanesi spam klasörüdür.',
      },
      de: {
        subject: 'So schreibst du eine Kaltnachricht, die beantwortet wird',
        preheader: 'Fünf Zeilen, eine Bitte, kein CV im Anhang.',
        intro: 'Eine Kaltnachricht ist keine Bitte um einen Gefallen, sondern eine kleine, leichte Frage. Beantwortet werden die kurzen, konkreten mit genau einem Anliegen.',
        tips: [
          { emoji: '🎯', title: 'Sag, warum genau diese Person', body: 'Eine Zeile, die zeigt, dass du hingeschaut hast: ihr Vortrag, ihr Team, ihr Beitrag. Ohne sie klingt es nach zweihundert Empfängern.' },
          { emoji: '🪶', title: 'Frag etwas, das in einer Antwort zu beantworten ist', body: '"Ist das Praktikum noch offen?" wird beantwortet. "Können Sie mich betreuen?" bleibt still.' },
          { emoji: '📎', title: 'Kein Anhang in der ersten Nachricht', body: 'Höchstens ein Link. Anhänge in Erstnachrichten landen im Filter, bevor ein Mensch sie sieht.' },
        ],
        action: 'Schick heute eine Nachricht. Eine ist eine Gewohnheit; zwanzig auf einmal sind der Spam-Ordner.',
      },
    },
  },
];

export function newsletterTemplate(key: string | null | undefined): NewsletterTemplate | null {
  if (!key) return null;
  return NEWSLETTER_TEMPLATES.find((t) => t.key === key) ?? null;
}

/**
 * The next template that has not been used yet, in library order — what the
 * auto-schedule reaches for. `usedKeys` is every `templateKey` already on a
 * Newsletter row, so a cadence walks the library once instead of re-sending the
 * first issue forever. Returns null when the library is exhausted, which the
 * caller reports rather than silently looping: "we ran out of content" is a
 * thing an admin needs to know.
 */
export function nextUnusedTemplate(
  usedKeys: Iterable<string>,
  audience?: NewsletterAudience
): NewsletterTemplate | null {
  const used = new Set(usedKeys);
  return (
    NEWSLETTER_TEMPLATES.find(
      (t) => !used.has(t.key) && (!audience || t.audience === audience)
    ) ?? null
  );
}
