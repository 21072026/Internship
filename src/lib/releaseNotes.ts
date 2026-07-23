// User-facing release notes (EN/TR/DE) — friendly, feature-level summaries for
// end users. Distinct from CHANGELOG.md, which is the developer-facing,
// commit-level record. Add a new entry here (newest first) alongside each
// notable release; bump APP_VERSION in package.json to match.

import type { Locale } from '@/i18n/config';

export interface ReleaseNote {
  version: string;
  date: string; // ISO date (release day)
  highlights: Record<Locale, string[]>;
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '0.25.8-beta',
    date: '2026-07-23',
    highlights: {
      en: ['Fixed: admins can now publish long announcements (release notes, articles). Longer messages were previously rejected with a "Validation failed" error.'],
      tr: ['Düzeltildi: yöneticiler artık uzun duyurular (sürüm notları, makaleler) yayınlayabiliyor. Daha uzun mesajlar önceden "Validation failed" hatasıyla reddediliyordu.'],
      de: ['Behoben: Admins können jetzt lange Ankündigungen (Release Notes, Artikel) veröffentlichen. Längere Nachrichten wurden zuvor mit einem „Validation failed“-Fehler abgelehnt.'],
    },
  },
  {
    version: '0.25.7-beta',
    date: '2026-07-23',
    highlights: {
      en: ['Fixed: when you schedule a meeting for several mentees at once, everyone now gets the same meeting link and joins one shared call — instead of each person getting a separate room.'],
      tr: ['Düzeltildi: birden çok menteeye aynı anda toplantı planladığınızda artık herkese aynı toplantı linki gidiyor ve tek bir ortak görüşmede buluşuluyor — önceki gibi herkese ayrı oda oluşturulmuyor.'],
      de: ['Behoben: Wenn du ein Meeting für mehrere Mentees gleichzeitig planst, erhalten jetzt alle denselben Meeting-Link und treffen sich in einem gemeinsamen Call — statt dass jede Person einen eigenen Raum bekommt.'],
    },
  },
  {
    version: '0.25.6-beta',
    date: '2026-07-23',
    highlights: {
      en: ['Customizable pipeline stages: an organization can now rename, reorder, recolor and define its own pipeline stages (Admin → Organizations → Edit stages), and they appear across the board, candidate filters, analytics and the mentee journey. Off by default — the standard stages are unchanged until a tenant customizes them.'],
      tr: ['Özelleştirilebilir pipeline aşamaları: bir organizasyon artık kendi aşamalarını yeniden adlandırabilir, sıralayabilir, renklendirebilir ve tanımlayabilir (Admin → Organizasyonlar → Aşamaları düzenle); bunlar board, aday filtreleri, analitik ve mentee sürecinde görünür. Varsayılan kapalı — bir kiracı özelleştirene kadar standart aşamalar değişmez.'],
      de: ['Anpassbare Pipeline-Phasen: Eine Organisation kann ihre Phasen jetzt umbenennen, neu anordnen, umfärben und eigene definieren (Admin → Organisationen → Phasen bearbeiten); sie erscheinen im Board, in Kandidatenfiltern, in der Analyse und im Mentee-Verlauf. Standardmäßig aus — die Standardphasen bleiben unverändert, bis ein Mandant sie anpasst.'],
    },
  },
  {
    version: '0.25.0-beta',
    date: '2026-07-22',
    highlights: {
      en: ['Enterprise single sign-on (SAML) is here: organizations can connect their own identity provider so their people sign in with corporate credentials — new users are created automatically on first login. Off by default; enable it per organization under Admin → Organizations.'],
      tr: ['Kurumsal tek oturum açma (SAML) geldi: organizasyonlar kendi kimlik sağlayıcılarını bağlayıp kullanıcıların kurumsal hesaplarıyla giriş yapmasını sağlayabilir — yeni kullanıcılar ilk girişte otomatik oluşturulur. Varsayılan kapalı; Admin → Organizasyonlar altından organizasyon bazında açılır.'],
      de: ['Enterprise Single Sign-on (SAML) ist da: Organisationen können ihren eigenen Identity Provider anbinden, damit sich ihre Leute mit Unternehmens-Anmeldedaten anmelden — neue Nutzer werden beim ersten Login automatisch angelegt. Standardmäßig aus; pro Organisation unter Admin → Organisationen aktivierbar.'],
    },
  },
  {
    version: '0.24.1-beta',
    date: '2026-07-22',
    highlights: {
      en: ['Invitation, password-reset and email-verification messages now carry your organization’s brand — its name, logo and accent color — when one is configured (unchanged for the default single-tenant setup).'],
      tr: ['Davet, parola sıfırlama ve e-posta doğrulama mesajları artık—yapılandırıldıysa—organizasyonunuzun markasını (adı, logosu ve vurgu rengi) taşıyor (varsayılan tek kiracılı kurulumda değişiklik yok).'],
      de: ['Einladungs-, Passwort-Reset- und E-Mail-Bestätigungsnachrichten tragen jetzt — sofern konfiguriert — die Marke deiner Organisation (Name, Logo und Akzentfarbe) (bei der standardmäßigen Einzelmandanten-Einrichtung unverändert).'],
    },
  },
  {
    version: '0.24.0-beta',
    date: '2026-07-22',
    highlights: {
      en: ['Behind the scenes: groundwork for hosting multiple organizations on one platform, with strict data separation between them. No change to how the app works today — it stays fully single-tenant until enabled.'],
      tr: ['Arka planda: tek platformda birden fazla organizasyonu barındırmak için altyapı hazırlığı yapıldı; aralarında katı veri ayrımı var. Bugünkü çalışma şekli değişmiyor — etkinleştirilene kadar tamamen tek kiracılı kalıyor.'],
      de: ['Im Hintergrund: Grundlage dafür, mehrere Organisationen auf einer Plattform zu hosten, mit strikter Datentrennung zwischen ihnen. Am heutigen Verhalten ändert sich nichts — die App bleibt vollständig einmandantenfähig, bis es aktiviert wird.'],
    },
  },
  {
    version: '0.23.3-beta',
    date: '2026-07-22',
    highlights: {
      en: [
        'Mentors now have a dedicated Analytics page — see your pipeline funnel, total interactions, active mentee count, and hired outcomes at a glance.',
        'Companies get their own Analytics page — view candidate stage distribution and interest signals (interested / shortlisted / pass) in one place.',
        'Admins can bulk-advance candidates: select multiple candidates and click "Advance stage" to move them all one pipeline step forward.',
        'Milestone celebrations: the mentee portal now shows a trophy banner at key career milestones — internship starting, in-progress, completed, hired, and employed.',
      ],
      tr: [
        'Mentörler artık ayrılmış bir Analitik sayfasına sahip — pipeline hunisi, toplam etkileşimler, aktif mentee sayısı ve işe alım sonuçlarını bir bakışta görün.',
        'Şirketler kendi Analitik sayfalarını alıyor — aday aşama dağılımını ve ilgi sinyallerini (ilgileniyor / kısa listeye aldı / geçti) tek yerden görün.',
        'Yöneticiler adayları toplu olarak ilerletebilir: birden fazla aday seçin ve "Aşamayı ilerlet" e tıklayarak hepsini bir adım öne taşıyın.',
        'Kilometre taşı kutlamaları: mentee portalı artık staj başlangıcı, devam, tamamlama, işe alındı ve iş bulundu gibi önemli kariyer aşamalarında kupa banner’ı gösteriyor.',
      ],
      de: [
        'Mentoren haben jetzt eine eigene Analyseseite — sehen Sie auf einen Blick Ihren Pipeline-Trichter, Gesamtinteraktionen, aktive Mentee-Anzahl und Einstellungsergebnisse.',
        'Unternehmen erhalten ihre eigene Analyseseite — Kandidaten-Stufenverteilung und Interessenssignale (interessiert / vorgemerkt / abgelehnt) an einem Ort.',
        'Admins können Kandidaten im Bulk-Verfahren voranschreiben: mehrere Kandidaten auswählen und auf „Stufe voranschreiten" klicken, um sie alle einen Schritt weiterzubringen.',
        'Meilenstein-Feiern: Das Mentee-Portal zeigt jetzt ein Pokal-Banner bei wichtigen Karriere-Meilensteinen — Praktikum beginnt, läuft, abgeschlossen, eingestellt und beschäftigt.',
      ],
    },
  },
  {
    version: '0.23.2-beta',
    date: '2026-07-22',
    highlights: {
      en: ['Emoji reactions can now be changed: tap your own reaction chip to open the picker and switch to a different emoji, or tap the same emoji again to remove it. Your current selection is highlighted in the picker.'],
      tr: ['Emoji tepkileri artık değiştirilebilir: kendi tepki chipine dokun, açılan seçiciden farklı bir emoji seç ya da aynı emojiye tekrar dokun ve kaldır. Seçtiğin emoji seçicide vurgulanır.'],
      de: ['Emoji-Reaktionen können jetzt geändert werden: Tippe auf deinen eigenen Reaktions-Chip, um den Picker zu öffnen und zu einem anderen Emoji zu wechseln, oder tippe erneut auf dasselbe Emoji, um es zu entfernen. Deine aktuelle Auswahl wird im Picker hervorgehoben.'],
    },
  },
  {
    version: '0.23.1-beta',
    date: '2026-07-22',
    highlights: {
      en: ['Message box polish: fixed the “Enter to send” switch overlapping its label, and pressing ↑ on an empty box now edits your last message.'],
      tr: ['Mesaj kutusu rötuşu: “Enter ile gönder” anahtarının etiketle çakışması düzeltildi; boş kutuda ↑ tuşuna basınca son mesajını düzenliyorsun.'],
      de: ['Feinschliff im Nachrichtenfeld: Der Schalter „Mit Enter senden“ überlappt sein Label nicht mehr, und ↑ im leeren Feld bearbeitet jetzt deine letzte Nachricht.'],
    },
  },
  {
    version: '0.23.0-beta',
    date: '2026-07-22',
    highlights: {
      en: ['You can now edit your own notes directly in the portal, then save or cancel your changes.'],
      tr: ['Artık portalda kendi notlarınızı doğrudan düzenleyebilir, ardından değişiklikleri kaydedebilir veya iptal edebilirsiniz.'],
      de: ['Du kannst deine eigenen Notizen jetzt direkt im Portal bearbeiten und die Änderungen anschließend speichern oder verwerfen.'],
    },
  },
  {
    version: '0.22.0-beta',
    date: '2026-07-21',
    highlights: {
      en: ['White-label: an organization’s own brand name and logo now appear in the app’s sidebar and top bar (set them under Admin → Organizations).'],
      tr: ['White-label: bir organizasyonun kendi marka adı ve logosu artık uygulamanın kenar çubuğunda ve üst barında görünüyor (Admin → Organizasyonlar’dan ayarla).'],
      de: ['White-Label: Der eigene Markenname und das Logo einer Organisation erscheinen jetzt in der Seitenleiste und der obersten Leiste der App (unter Admin → Organisationen einstellbar).'],
    },
  },
  {
    version: '0.21.0-beta',
    date: '2026-07-21',
    highlights: {
      en: ['New “Enter to send” toggle in the message box — turn it on to send with Enter (Shift+Enter for a new line), or leave it off to send with Shift+Enter. Your choice is remembered.'],
      tr: ['Mesaj kutusunda yeni “Enter ile gönder” anahtarı — açarsan Enter ile gönderirsin (Shift+Enter alt satır), kapalı bırakırsan Shift+Enter ile gönderirsin. Tercihin hatırlanır.'],
      de: ['Neuer Schalter „Mit Enter senden“ im Nachrichtenfeld — aktiviert sendest du mit Enter (Umschalt+Enter für neue Zeile), deaktiviert sendest du mit Umschalt+Enter. Deine Wahl wird gemerkt.'],
    },
  },
  {
    version: '0.20.0-beta',
    date: '2026-07-21',
    highlights: {
      en: ['If you miss messages, you now get a single hourly “unread messages” email summary instead of one email per message — and only if you haven’t opted out.'],
      tr: ['Mesajları kaçırırsan, artık her mesaj için ayrı e-posta yerine saatte bir tek “okunmamış mesajlar” özeti alıyorsun — ve yalnızca kapatmadıysan.'],
      de: ['Wenn du Nachrichten verpasst, erhältst du jetzt eine einzige stündliche „ungelesene Nachrichten“-Zusammenfassung statt einer E-Mail pro Nachricht — und nur, wenn du es nicht deaktiviert hast.'],
    },
  },
  {
    version: '0.19.0-beta',
    date: '2026-07-21',
    highlights: {
      en: ['React to messages with emoji (👍 ❤️ 😂 😮 🎉) — tap the reaction button on any message and see reaction counts, just like WhatsApp or Slack.'],
      tr: ['Mesajlara emoji ile tepki ver (👍 ❤️ 😂 😮 🎉) — herhangi bir mesajdaki tepki butonuna dokun, tepki sayılarını gör; tıpkı WhatsApp veya Slack gibi.'],
      de: ['Reagiere auf Nachrichten mit Emojis (👍 ❤️ 😂 😮 🎉) — tippe bei einer Nachricht auf die Reaktionsschaltfläche und sieh die Reaktionszahlen, wie bei WhatsApp oder Slack.'],
    },
  },
  {
    version: '0.18.0-beta',
    date: '2026-07-21',
    highlights: {
      en: ['Messages now show WhatsApp-style read receipts — a single tick when delivered and a blue double tick once your message has been read.'],
      tr: ['Mesajlarda artık WhatsApp tarzı okundu tikleri var — iletildiğinde tek tik, mesajın okunduğunda mavi çift tik.'],
      de: ['Nachrichten zeigen jetzt WhatsApp-artige Lesebestätigungen — ein Häkchen bei Zustellung und ein blaues Doppelhäkchen, sobald deine Nachricht gelesen wurde.'],
    },
  },
  {
    version: '0.17.1-beta',
    date: '2026-07-21',
    highlights: {
      en: ['Dark mode: text inside colored info boxes (like the portal’s “complete your profile” note) is now readable instead of dark-on-dark.'],
      tr: ['Koyu tema: renkli bilgi kutularındaki yazılar (ör. portaldaki “profilini tamamla” notu) artık koyu-üstüne-koyu yerine okunaklı.'],
      de: ['Dunkelmodus: Text in farbigen Infoboxen (z. B. der Hinweis „Profil vervollständigen“ im Portal) ist jetzt lesbar statt dunkel auf dunkel.'],
    },
  },
  {
    version: '0.17.0-beta',
    date: '2026-07-21',
    highlights: {
      en: ['Filter the candidate list by pipeline stage, and — in the mentee portal — your journey/pipeline stage now shows at the top of the page without scrolling.'],
      tr: ['Aday listesini pipeline aşamasına göre filtrele; mentee portalında ise yolculuk/pipeline aşaman artık sayfanın en üstünde, kaydırmadan görünüyor.'],
      de: ['Filtere die Kandidatenliste nach Pipeline-Phase; im Mentee-Portal wird deine Journey-/Pipeline-Phase jetzt ganz oben ohne Scrollen angezeigt.'],
    },
  },
  {
    version: '0.16.0-beta',
    date: '2026-07-21',
    highlights: {
      en: ['Admins can now log an interaction directly from a candidate’s page and send targeted email to mentees from a new Email page — matching what mentors can do.'],
      tr: ['Adminler artık bir adayın sayfasından doğrudan etkileşim ekleyebilir ve yeni E-posta sayfasından mentee’lere hedefli e-posta gönderebilir — tıpkı mentörler gibi.'],
      de: ['Admins können jetzt direkt auf der Seite einer Kandidatin/eines Kandidaten eine Interaktion erfassen und über eine neue E-Mail-Seite gezielt E-Mails an Mentees senden — genau wie Mentoren.'],
    },
  },
  {
    version: '0.15.0-beta',
    date: '2026-07-21',
    highlights: {
      en: ['Edit and delete your messages — fix a typo (shows an “edited” label), or delete a message for everyone (leaves a “deleted” placeholder) or just for yourself.'],
      tr: ['Mesajlarını düzenle ve sil — bir yazım hatasını düzelt (“düzenlendi” etiketi görünür) ya da bir mesajı herkesten sil (“silindi” yer tutucusu kalır) veya yalnızca kendinden sil.'],
      de: ['Nachrichten bearbeiten und löschen — einen Tippfehler korrigieren (zeigt „bearbeitet“), oder eine Nachricht für alle löschen (hinterlässt einen „gelöscht“-Platzhalter) oder nur für dich.'],
    },
  },
  {
    version: '0.14.7-beta',
    date: '2026-07-21',
    highlights: {
      en: ['The mentor getting-started checklist now disappears once you’ve completed the essential steps (scheduling a meeting is correctly optional).'],
      tr: ['Mentör başlangıç kontrol listesi, temel adımları tamamlayınca artık kayboluyor (toplantı planlamak doğru şekilde isteğe bağlı).'],
      de: ['Die Mentor-Startcheckliste verschwindet jetzt, sobald du die wesentlichen Schritte erledigt hast (das Planen eines Meetings ist korrekt optional).'],
    },
  },
  {
    version: '0.14.6-beta',
    date: '2026-07-21',
    highlights: {
      en: ['When a page fails to load its data, you now see a clear error instead of a blank screen, and saving an evaluation shows an error if it doesn’t go through.'],
      tr: ['Bir sayfa verisini yükleyemediğinde artık boş ekran yerine net bir hata görüyorsun; bir değerlendirme kaydedilmezse hata gösteriliyor.'],
      de: ['Wenn eine Seite ihre Daten nicht laden kann, siehst du jetzt einen klaren Fehler statt eines leeren Bildschirms, und beim Speichern einer Bewertung wird ein Fehler angezeigt, falls es nicht klappt.'],
    },
  },
  {
    version: '0.14.5-beta',
    date: '2026-07-21',
    highlights: {
      en: ['The language shown in Account settings now always matches the actual interface language.'],
      tr: ['Hesap ayarlarında görünen dil artık her zaman arayüzün gerçek diliyle aynı.'],
      de: ['Die in den Kontoeinstellungen angezeigte Sprache stimmt jetzt immer mit der tatsächlichen Oberflächensprache überein.'],
    },
  },
  {
    version: '0.14.4-beta',
    date: '2026-07-21',
    highlights: {
      en: ['Contacting your mentor from the portal is more reliable — use the in-app “Message mentor” button; the email address is now a clickable link.'],
      tr: ['Portaldan mentörünle iletişim daha güvenilir — uygulama-içi “Mentöre mesaj” butonunu kullan; e-posta adresi artık tıklanabilir bir bağlantı.'],
      de: ['Die Kontaktaufnahme mit deinem Mentor über das Portal ist zuverlässiger — nutze die In-App-Schaltfläche „Mentor benachrichtigen“; die E-Mail-Adresse ist jetzt ein anklickbarer Link.'],
    },
  },
  {
    version: '0.14.2-beta',
    date: '2026-07-21',
    highlights: {
      en: ['Fixed a broken app icon (the `/icon.svg` address returned an error).'],
      tr: ['Bozuk uygulama simgesi düzeltildi (`/icon.svg` adresi hata veriyordu).'],
      de: ['Ein defektes App-Symbol behoben (die Adresse `/icon.svg` gab einen Fehler zurück).'],
    },
  },
  {
    version: '0.14.1-beta',
    date: '2026-07-20',
    highlights: {
      en: ['Meeting invite emails now correctly say “Meeting link” instead of “Google Meet” (the links are Jitsi).'],
      tr: ['Toplantı davet e-postaları artık “Google Meet” yerine doğru şekilde “Toplantı bağlantısı” diyor (bağlantılar Jitsi).'],
      de: ['Meeting-Einladungs-E-Mails sagen jetzt korrekt „Meeting-Link“ statt „Google Meet“ (die Links sind Jitsi).'],
    },
  },
  {
    version: '0.14.0-beta',
    date: '2026-07-20',
    highlights: {
      en: [
        'Add mentees to a project with a functional role — Developer, Tester, or Marketing — so a project shows who does what.',
      ],
      tr: [
        'Projeye mentee’leri işlevsel rolüyle ekle — Geliştirici, Test uzmanı veya Pazarlama — böylece projede kimin ne yaptığı görünür.',
      ],
      de: [
        'Füge Mentees mit einer funktionalen Rolle zu einem Projekt hinzu — Entwickler, Tester oder Marketing — damit ersichtlich ist, wer was macht.',
      ],
    },
  },
  {
    version: '0.13.0-beta',
    date: '2026-07-20',
    highlights: {
      en: [
        'Browser notifications — turn them on in Account → Notifications and get a desktop popup for new messages while the app is open.',
      ],
      tr: [
        'Tarayıcı bildirimleri — Hesap → Bildirimler’den aç, uygulama açıkken yeni mesajlarda masaüstü bildirimi al.',
      ],
      de: [
        'Browser-Benachrichtigungen — aktiviere sie unter Konto → Benachrichtigungen und erhalte bei neuen Nachrichten ein Desktop-Popup, solange die App geöffnet ist.',
      ],
    },
  },
  {
    version: '0.12.0-beta',
    date: '2026-07-20',
    highlights: {
      en: [
        'See how long you’ve been a member — your account page now shows “Member for 3 months”.',
        'Project members now show how long each person has been on the project.',
      ],
      tr: [
        'Ne zamandır üye olduğunu gör — hesap sayfanda artık “Üyelik süresi: 3 ay” yazıyor.',
        'Proje üyelerinde her kişinin projede ne kadar süredir olduğu görünüyor.',
      ],
      de: [
        'Sieh, wie lange du schon Mitglied bist — deine Kontoseite zeigt jetzt „Mitglied seit 3 Monaten“.',
        'Bei Projektmitgliedern wird jetzt angezeigt, wie lange jede Person schon im Projekt ist.',
      ],
    },
  },
  {
    version: '0.11.0-beta',
    date: '2026-07-20',
    highlights: {
      en: [
        'Paste images into messages — copy an image and paste it right into the reply box; it shows as a thumbnail you can preview and remove, and it’s sent with your message.',
        'Attach several files at once to a single message.',
        'Message attachments (including pasted images) now also arrive in the email notification.',
      ],
      tr: [
        'Mesajlara resim yapıştır — bir resmi kopyalayıp doğrudan yanıt kutusuna yapıştır; önizleyip kaldırabileceğin bir küçük resim olarak görünür ve mesajınla birlikte gönderilir.',
        'Tek mesaja aynı anda birden çok dosya ekle.',
        'Mesaj ekleri (yapıştırılan resimler dâhil) artık e-posta bildiriminde de geliyor.',
      ],
      de: [
        'Bilder in Nachrichten einfügen — ein Bild kopieren und direkt ins Antwortfeld einfügen; es erscheint als Miniaturansicht zum Vorschauen und Entfernen und wird mit der Nachricht gesendet.',
        'Mehrere Dateien gleichzeitig an eine Nachricht anhängen.',
        'Nachrichtenanhänge (auch eingefügte Bilder) kommen jetzt auch in der E-Mail-Benachrichtigung an.',
      ],
    },
  },
  {
    version: '0.10.0-beta',
    date: '2026-07-20',
    highlights: {
      en: [
        'Schedule a meeting without a fixed time — if you set a time, attendees are asked to RSVP and get a reminder; if you don’t, it’s simply a shared meeting link with no RSVP.',
        '“Select all” when scheduling — pick every mentee in the list with one click.',
      ],
      tr: [
        'Sabit zaman olmadan toplantı planla — bir zaman belirlersen katılımcılardan RSVP istenir ve hatırlatma gider; belirlemezsen sadece paylaşılan bir toplantı linki olur, RSVP’siz.',
        'Planlarken “tümünü seç” — listedeki her mentee’yi tek tıkla seç.',
      ],
      de: [
        'Meeting ohne feste Zeit planen — mit Zeit werden Teilnehmer um RSVP gebeten und erhalten eine Erinnerung; ohne Zeit ist es einfach ein geteilter Meeting-Link ohne RSVP.',
        '„Alle auswählen“ beim Planen — jeden Mentee der Liste mit einem Klick wählen.',
      ],
    },
  },
  {
    version: '0.9.1-beta',
    date: '2026-07-20',
    highlights: {
      en: ['A clearer “back” link on a project’s page — it now takes you back to your project list instead of the public showcase.'],
      tr: ['Proje sayfasında daha net bir “geri” linki — artık sizi herkese açık vitrin yerine kendi proje listenize götürüyor.'],
      de: ['Ein klarerer „Zurück“-Link auf der Projektseite — er führt Sie jetzt zu Ihrer Projektliste zurück statt zur öffentlichen Vitrine.'],
    },
  },
  {
    version: '0.9.0-beta',
    date: '2026-07-20',
    highlights: {
      en: [
        'Meetings for admins — admins can now schedule and see meetings from a dedicated page, and every meeting has a one-click “Copy link” button (mentors get this too).',
        'Schedule a meeting straight from a candidate’s page — no need to leave the profile you’re looking at.',
        'Archive mentors — hide inactive mentors from the Mentors list (and bring them back) without losing any of their history.',
        'Plan limits now apply — programs on a limited plan are gently stopped from adding new mentorships past their limit; existing mentees are never affected.',
      ],
      tr: [
        'Adminler için toplantılar — adminler artık ayrı bir sayfadan toplantı planlayıp görebiliyor ve her toplantıda tek tıkla “Bağlantıyı kopyala” butonu var (mentörler de faydalanıyor).',
        'Adayın sayfasından doğrudan toplantı planla — baktığın profilden ayrılmana gerek yok.',
        'Mentör arşivle — pasif mentörleri geçmişlerini kaybetmeden Mentörler listesinden gizle (ve geri getir).',
        'Plan limitleri artık geçerli — sınırlı plandaki programlar limit üstü yeni mentorluk eklemede nazikçe durduruluyor; mevcut mentee’ler asla etkilenmiyor.',
      ],
      de: [
        'Meetings für Admins — Admins können Meetings jetzt über eine eigene Seite planen und einsehen, und jedes Meeting hat einen „Link kopieren“-Button mit einem Klick (auch für Mentoren).',
        'Meeting direkt von der Kandidatenseite planen — ohne das Profil zu verlassen.',
        'Mentoren archivieren — inaktive Mentoren aus der Mentorenliste ausblenden (und zurückholen), ohne ihre Historie zu verlieren.',
        'Plan-Limits greifen jetzt — Programme mit begrenztem Tarif werden am Anlegen neuer Mentorships über dem Limit sanft gehindert; bestehende Mentees sind nie betroffen.',
      ],
    },
  },
  {
    version: '0.8.0-beta',
    date: '2026-07-17',
    highlights: {
      en: [
        'Run several programs on one platform — a new Organizations area lets an administrator create and manage separate programs, each with its own plan, and see how much data each holds.',
        'Your own look — each program can set its name, logo, accent color and support email (white-label), and configure enterprise single sign-on (SAML/OIDC).',
        'Know where you stand — a new benchmark compares your hiring-funnel conversion against the anonymized platform average; no other program’s data is ever shown.',
        'Google Calendar — the groundwork is in: administrators can see the integration status and follow the setup guide to connect it.',
        'Sign-in fixes — resolved a Safari sign-in loop, and “forgot password” now reliably finds your account regardless of capitalization or spaces in your email.',
      ],
      tr: [
        'Tek platformda birden çok program — yeni Organizasyonlar alanı, yöneticinin her biri kendi planına sahip ayrı programlar oluşturup yönetmesini ve her birinin ne kadar veri tuttuğunu görmesini sağlar.',
        'Kendi görünümün — her program kendi adını, logosunu, vurgu rengini ve destek e-postasını belirleyebilir (white-label) ve kurumsal tek oturum açmayı (SAML/OIDC) yapılandırabilir.',
        'Nerede olduğunu bil — yeni kıyaslama, işe alım huni dönüşümünü anonimleştirilmiş platform ortalamasıyla karşılaştırır; başka hiçbir programın verisi gösterilmez.',
        'Google Takvim — altyapı hazır: yöneticiler entegrasyon durumunu görebilir ve kurulum kılavuzunu izleyerek bağlayabilir.',
        'Giriş düzeltmeleri — Safari’deki giriş döngüsü giderildi ve “şifremi unuttum” artık e-postandaki büyük/küçük harf veya boşluk farkına bakmaksızın hesabını güvenilir biçimde buluyor.',
      ],
      de: [
        'Mehrere Programme auf einer Plattform — im neuen Bereich Organisationen kann eine Administratorin separate Programme mit je eigenem Tarif anlegen und verwalten und sehen, wie viele Daten jedes enthält.',
        'Ihr eigenes Erscheinungsbild — jedes Programm kann Name, Logo, Akzentfarbe und Support-E-Mail festlegen (White-Label) und Enterprise-Single-Sign-on (SAML/OIDC) konfigurieren.',
        'Standortbestimmung — ein neuer Benchmark vergleicht Ihre Einstellungs-Funnel-Conversion mit dem anonymisierten Plattformdurchschnitt; Daten anderer Programme werden nie angezeigt.',
        'Google Kalender — die Grundlage steht: Administratoren sehen den Integrationsstatus und können ihn per Anleitung verbinden.',
        'Anmelde-Fixes — eine Safari-Anmeldeschleife wurde behoben, und „Passwort vergessen“ findet Ihr Konto jetzt zuverlässig, unabhängig von Groß-/Kleinschreibung oder Leerzeichen in der E-Mail.',
      ],
    },
  },
  {
    version: '0.7.0-beta',
    date: '2026-07-11',
    highlights: {
      en: [
        'Projects, rebuilt — the screen now opens with rich project cards (who is on it, tech, links, progress); the form appears only when you add or edit. Every project has a detail page.',
        'Share project ownership — projects can now have several owners and several mentors. Owners add or remove people from the card and can hand a project over in one step.',
        'Clear roles — the project name, status, visibility and dates can only be changed by an owner; everyone on the project can work on the description, links, goals and tasks.',
      ],
      tr: [
        'Projeler yenilendi — ekran artık zengin proje kartlarıyla açılıyor (kimler var, teknolojiler, linkler, ilerleme); form yalnızca ekleme/düzenlemede geliyor. Her projenin bir detay sayfası var.',
        'Proje sahipliğini paylaş — projelerde artık birden çok owner ve birden çok mentör olabiliyor. Owner’lar kart üzerinden kişi ekleyip çıkarabiliyor ve projeyi tek adımda devredebiliyor.',
        'Net roller — proje adı, durumu, görünürlüğü ve tarihlerini yalnızca owner değiştirebilir; projedeki herkes açıklama, linkler, hedefler ve görevler üzerinde çalışabilir.',
      ],
      de: [
        'Projekte, neu gebaut — der Bildschirm öffnet jetzt mit reichhaltigen Projektkarten (wer dabei ist, Technologien, Links, Fortschritt); das Formular erscheint nur beim Anlegen/Bearbeiten. Jedes Projekt hat eine Detailseite.',
        'Geteilte Projektverantwortung — Projekte können jetzt mehrere Owner und mehrere Mentoren haben. Owner fügen Personen direkt auf der Karte hinzu und übergeben ein Projekt in einem Schritt.',
        'Klare Rollen — Name, Status, Sichtbarkeit und Termine ändert nur ein Owner; an Beschreibung, Links, Zielen und Aufgaben arbeiten alle Projektmitglieder.',
      ],
    },
  },
  {
    version: '0.6.0-beta',
    date: '2026-07-11',
    highlights: {
      en: [
        'Join on your own — you can now sign up directly as a mentee; an admin approves your account and you land in your portal.',
        'Request a mentor — once your profile basics and CV are in place, ask for a mentor right from your dashboard; admins match you and you are notified the moment it is decided.',
        'Built-in support — every user has a pinned "Support" conversation in Messages. Write to us anytime; you can follow the status of your request (open, in progress, closed) and get notified on replies.',
        'New Features page — everything InternshipCRM can do, categorized and in three languages, linked from the landing page.',
      ],
      tr: [
        'Kendi başına katıl — artık doğrudan mentee olarak kaydolabilirsin; hesabını bir admin onaylar ve portalına ulaşırsın.',
        'Mentör talep et — temel profil bilgilerin ve CV’in hazır olduğunda panelinden mentör isteyebilirsin; adminler eşleştirir ve karar verilir verilmez haberdar olursun.',
        'Yerleşik destek — her kullanıcının Mesajlar’da sabit bir "Destek" sohbeti var. Bize istediğin an yaz; talebinin durumunu (açık, işlemde, kapalı) takip edebilir ve yanıtlarda bildirim alırsın.',
        'Yeni Özellikler sayfası — InternshipCRM’in yapabildiği her şey, kategorili ve üç dilde, açılış sayfasından erişilebilir.',
      ],
      de: [
        'Selbst beitreten — du kannst dich jetzt direkt als Mentee registrieren; ein Admin bestätigt dein Konto und du landest in deinem Portal.',
        'Mentor anfragen — sobald Profilbasics und Lebenslauf vorliegen, fragst du direkt vom Dashboard einen Mentor an; Admins vermitteln und du wirst sofort über die Entscheidung informiert.',
        'Eingebauter Support — jede*r hat in den Nachrichten eine angeheftete "Support"-Unterhaltung. Schreib uns jederzeit; du verfolgst den Status deiner Anfrage (offen, in Bearbeitung, geschlossen) und wirst bei Antworten benachrichtigt.',
        'Neue Funktionsseite — alles, was InternshipCRM kann, kategorisiert und in drei Sprachen, verlinkt von der Startseite.',
      ],
    },
  },
  {
    version: '0.5.0-beta',
    date: '2026-07-11',
    highlights: {
      en: [
        'You decide who sees you — companies can only find you in talent search after your explicit consent, and a friendly banner helps you choose. Withdrawing hides you immediately.',
        'AI helpers for mentees (free for you): constructive CV feedback and an interview-prep assistant with realistic questions and tips for your target position.',
        'AI helpers for mentors: one-click summary of your interaction log with a mentee — progress, themes, risks and next steps (with the mentee’s permission).',
        'Smarter mentor matching — suggestions now come with a short AI rationale; without AI they gracefully fall back to skill overlap.',
        'Premium analytics for admins: cohort comparison, conversion per referral source, a full printable/Excel report and a weekly report email.',
        'Fair AI usage — a monthly AI quota managed in Settings; mentees never see pricing or quotas.',
      ],
      tr: [
        'Seni kimin göreceğine sen karar verirsin — şirketler seni ancak açık iznin sonrasında yetenek aramasında bulabilir; dostça bir banner seçim yapmana yardım eder. İzni geri çekince anında gizlenirsin.',
        'Mentee’lere AI yardımcıları (senin için ücretsiz): yapıcı CV geri bildirimi ve hedef pozisyonuna uygun gerçekçi sorular + ipuçlarıyla mülakat hazırlık asistanı.',
        'Mentörlere AI yardımcıları: bir mentee ile etkileşim kaydının tek tıkla özeti — ilerleme, temalar, riskler ve sonraki adımlar (mentee’nin izniyle).',
        'Daha akıllı mentör eşleştirme — öneriler artık kısa bir AI gerekçesiyle geliyor; AI yoksa yetenek örtüşmesine zarifçe düşüyor.',
        'Adminlere premium analitik: cohort karşılaştırması, kaynak bazlı dönüşüm, yazdırılabilir/Excel tam rapor ve haftalık rapor e-postası.',
        'Adil AI kullanımı — Ayarlar’dan yönetilen aylık AI kotası; mentee’ler asla fiyat veya kota görmez.',
      ],
      de: [
        'Du entscheidest, wer dich sieht — Unternehmen finden dich in der Talentsuche erst nach deiner ausdrücklichen Einwilligung; ein freundlicher Hinweis hilft dir bei der Wahl. Ein Widerruf verbirgt dich sofort.',
        'KI-Helfer für Mentees (für dich kostenlos): konstruktives Lebenslauf-Feedback und ein Interview-Vorbereitungsassistent mit realistischen Fragen und Tipps für deine Zielposition.',
        'KI-Helfer für Mentoren: Ein-Klick-Zusammenfassung des Interaktionsprotokolls mit einem Mentee — Fortschritt, Themen, Risiken und nächste Schritte (mit Einwilligung des Mentees).',
        'Intelligenteres Mentoren-Matching — Vorschläge kommen jetzt mit einer kurzen KI-Begründung; ohne KI greift die Fähigkeiten-Überschneidung.',
        'Premium-Analytik für Admins: Cohort-Vergleich, Konversion pro Quelle, ein druckbarer/Excel-Gesamtbericht und eine wöchentliche Berichts-E-Mail.',
        'Faire KI-Nutzung — ein monatliches KI-Kontingent in den Einstellungen; Mentees sehen nie Preise oder Kontingente.',
      ],
    },
  },
  {
    version: '0.4.0-beta',
    date: '2026-07-10',
    highlights: {
      en: [
        'Company Premium — companies can now search a privacy-safe talent pool of mentees who opted in, see a "verified" candidate card with mentor evaluations and project work, get alerts when a candidate matches an open position, and preview newly-hireable candidates first. Mentor and mentee features stay free.',
        'Messaging is easier to reach — a new inbox icon in the header and a single Messages page for all your conversations.',
        'Daily activity report — mentors and admins can get a daily summary of mentee activity (logins, time on site, pages visited, completed to-dos).',
        'Mentor attention queue — mentees with no open goal are now flagged, and you get an in-app heads-up when a mentee goes quiet.',
        'Tidier admin — deactivated users move to an "Archived" tab instead of cluttering the list; assign a mentor to a candidate right from the Candidates screen.',
        'Personalization — pick your own accent color for the app.',
        'Fixes — mobile users can now reach Sign out from the menu; editing a company with empty optional fields no longer errors; emails land in the inbox more reliably.',
      ],
      tr: [
        'Şirket Premium — şirketler artık rıza vermiş mentee’lerden oluşan gizlilik-güvenli bir yetenek havuzunda arama yapabilir, mentör değerlendirmeleri ve proje çalışmasıyla "doğrulanmış" aday kartını görebilir, açık pozisyona uyan aday çıkınca bildirim alabilir ve yeni işe alınabilir adayları önce görebilir. Mentör ve mentee özellikleri ücretsiz kalır.',
        'Mesajlaşmaya erişim kolaylaştı — başlıkta yeni bir gelen kutusu ikonu ve tüm sohbetleriniz için tek bir Mesajlar sayfası.',
        'Günlük aktivite raporu — mentör ve adminler mentee aktivitesinin (giriş, sitede geçen süre, gezilen sayfalar, tamamlanan görevler) günlük özetini alabilir.',
        'Mentor dikkat kuyruğu — açık hedefi olmayan mentee’ler artık işaretleniyor ve bir mentee sessizleştiğinde uygulama içi uyarı alıyorsunuz.',
        'Daha derli admin — pasifleştirilen kullanıcılar listeyi doldurmak yerine "Arşiv" sekmesine taşınıyor; adayı doğrudan Adaylar ekranından bir mentöre atayabilirsiniz.',
        'Kişiselleştirme — uygulama için kendi vurgu renginizi seçin.',
        'Düzeltmeler — mobil kullanıcılar artık menüden Çıkış’a ulaşabiliyor; opsiyonel alanları boş bir şirketi düzenlemek artık hata vermiyor; e-postalar gelen kutusuna daha güvenilir ulaşıyor.',
      ],
      de: [
        'Unternehmens-Premium — Unternehmen können jetzt in einem datenschutzfreundlichen Talent-Pool von Mentees suchen, die zugestimmt haben, eine „verifizierte" Kandidatenkarte mit Mentor-Bewertungen und Projektarbeit sehen, Benachrichtigungen bei passenden Kandidaten erhalten und neu vermittelbare Kandidaten zuerst sehen. Mentor- und Mentee-Funktionen bleiben kostenlos.',
        'Nachrichten sind leichter erreichbar — ein neues Posteingang-Symbol in der Kopfzeile und eine einzige Nachrichten-Seite für alle Unterhaltungen.',
        'Täglicher Aktivitätsbericht — Mentoren und Admins erhalten eine tägliche Zusammenfassung der Mentee-Aktivität (Logins, Verweildauer, besuchte Seiten, erledigte To-dos).',
        'Mentor-Aufmerksamkeitsliste — Mentees ohne offenes Ziel werden jetzt markiert, und du bekommst einen In-App-Hinweis, wenn ein Mentee still wird.',
        'Aufgeräumtere Verwaltung — deaktivierte Nutzer wandern in einen „Archiviert"-Tab, statt die Liste zu überladen; weise einem Kandidaten direkt aus der Kandidaten-Ansicht einen Mentor zu.',
        'Personalisierung — wähle deine eigene Akzentfarbe für die App.',
        'Korrekturen — Mobile Nutzer erreichen jetzt „Abmelden" im Menü; das Bearbeiten eines Unternehmens mit leeren optionalen Feldern schlägt nicht mehr fehl; E-Mails landen zuverlässiger im Posteingang.',
      ],
    },
  },
  {
    version: '0.3.0-beta',
    date: '2026-07-03',
    highlights: {
      en: [
        'Meetings & calendar — schedule a meeting, mentees RSVP with one click, and everything shows on the calendar with reminder emails.',
        'Smarter mentor matching — suggestions now rank by real skill overlap, and mentors can set their expertise and how many mentees they can take on.',
        'Analytics you can trust — "time in stage" is now computed from real pipeline history, plus a date-range filter (last 30/90 days, 6/12 months).',
        'Cleaner pipeline board — the 13 stages are grouped into collapsible phases (pre-internship / internship / outcome), with overdue flags and a workload hint.',
        'Account security — your organization can require two-factor authentication, sessions time out automatically, and you can now "sign out of all devices".',
        'Privacy — cookie consent is now by category (necessary / analytics / …), and the whole app is fully translated in English, Turkish and German.',
        'Everyday polish — invitation status with timestamps, confirmation toasts on changes, editable notes, a dedicated My Notes page, message attachments, and an adjustable font size.',
      ],
      tr: [
        'Toplantılar & takvim — toplantı planla, mentee’ler tek tıkla katılım (RSVP) versin; her şey hatırlatma e-postalarıyla takvimde görünsün.',
        'Daha akıllı mentor eşleştirme — öneriler artık gerçek yetenek örtüşmesine göre sıralanıyor; mentörler uzmanlıklarını ve kaç mentee alabileceklerini belirleyebiliyor.',
        'Güvenilir analitik — "aşamada geçen süre" artık gerçek süreç geçmişinden hesaplanıyor; ayrıca tarih aralığı filtresi (son 30/90 gün, 6/12 ay).',
        'Daha derli toplu pano — 13 aşama katlanabilir fazlara gruplandı (staj öncesi / staj / sonuç); gecikme işaretleri ve iş yükü uyarısıyla.',
        'Hesap güvenliği — kuruluşunuz iki adımlı doğrulamayı zorunlu kılabilir, oturumlar otomatik zaman aşımına uğrar ve artık "tüm cihazlardan çıkış" yapabilirsiniz.',
        'Gizlilik — çerez rızası artık kategori bazlı (gerekli / analitik / …) ve tüm uygulama İngilizce, Türkçe ve Almanca olarak eksiksiz çevrildi.',
        'Günlük iyileştirmeler — zaman damgalı davet durumu, değişikliklerde onay bildirimleri, düzenlenebilir notlar, ayrı bir Notlarım sayfası, mesaj ekleri ve ayarlanabilir yazı boyutu.',
      ],
      de: [
        'Meetings & Kalender — plane ein Meeting, Mentees sagen mit einem Klick zu (RSVP), und alles erscheint im Kalender samt Erinnerungs-E-Mails.',
        'Intelligenteres Mentoren-Matching — Vorschläge werden nach echter Fähigkeiten-Überschneidung sortiert, und Mentoren können ihre Expertise und Kapazität festlegen.',
        'Verlässliche Analysen — die „Zeit in Phase" wird jetzt aus dem echten Pipeline-Verlauf berechnet, plus ein Zeitraumfilter (letzte 30/90 Tage, 6/12 Monate).',
        'Übersichtlicheres Board — die 13 Phasen sind in einklappbare Abschnitte gruppiert (vor dem Praktikum / Praktikum / Ergebnis), mit Überfällig-Markierungen und Auslastungshinweis.',
        'Kontosicherheit — deine Organisation kann Zwei-Faktor-Authentifizierung verlangen, Sitzungen laufen automatisch ab, und du kannst dich jetzt „von allen Geräten abmelden".',
        'Datenschutz — die Cookie-Einwilligung erfolgt jetzt kategorienweise (notwendig / Analyse / …), und die gesamte App ist vollständig auf Englisch, Türkisch und Deutsch übersetzt.',
        'Feinschliff im Alltag — Einladungsstatus mit Zeitstempeln, Bestätigungs-Toasts bei Änderungen, bearbeitbare Notizen, eine eigene „Meine Notizen"-Seite, Nachrichtenanhänge und eine anpassbare Schriftgröße.',
      ],
    },
  },
  {
    version: '0.2.0-beta',
    date: '2026-07-01',
    highlights: {
      en: [
        'Dark mode — follows your system by default, or switch it yourself from any sidebar. Your choice is remembered on your account.',
        'CV tools — upload your CV and get one-click suggestions for your profile fields and skills, parsed locally on our server (nothing sent anywhere). An optional AI-assisted mode can fill in more fields once you turn it on in Account → Privacy.',
        'Document templates — CV, cover letter, interview-prep checklist and more, now with an in-app preview and export to PDF, Word-friendly text, or Markdown, in your language.',
        'Public profile upgrades — visitors can switch language and theme, get a link back to InternshipCRM, and send you a message directly (spam-protected).',
        'Skill ratings — self-assess your skills with a simple 1–5 star picker instead of a dropdown.',
        'A number of dark-mode and navigation polish fixes across the app.',
      ],
      tr: [
        'Karanlık mod — varsayılan olarak işletim sisteminizi takip eder, dilerseniz herhangi bir kenar çubuğundan değiştirebilirsiniz. Tercihiniz hesabınızda hatırlanır.',
        'CV araçları — CV\'nizi yükleyin, profil alanlarınız ve becerileriniz için tek tıkla öneriler alın; işlem sunucumuzda yerel olarak yapılır (hiçbir yere gönderilmez). Hesap → Gizlilik\'ten açtığınızda isteğe bağlı AI destekli mod daha fazla alanı doldurabilir.',
        'Doküman şablonları — CV, ön yazı, mülakat hazırlık listesi ve daha fazlası; artık uygulama içi önizleme ve dilinizde PDF, Word-uyumlu metin veya Markdown olarak dışa aktarma ile.',
        'Herkese açık profil geliştirmeleri — ziyaretçiler dil ve temayı değiştirebilir, InternshipCRM\'e geri dönen bir bağlantı görebilir ve size doğrudan mesaj gönderebilir (spam korumalı).',
        'Yetenek değerlendirmesi — becerilerinizi açılır menü yerine basit bir 1–5 yıldız seçiciyle değerlendirin.',
        'Uygulama genelinde çok sayıda karanlık mod ve gezinme iyileştirmesi.',
      ],
      de: [
        'Dunkelmodus — folgt standardmäßig deinem System, oder wechsle ihn selbst über jede Seitenleiste. Deine Wahl wird für dein Konto gespeichert.',
        'Lebenslauf-Tools — lade deinen Lebenslauf hoch und erhalte mit einem Klick Vorschläge für deine Profilfelder und Fähigkeiten, lokal auf unserem Server verarbeitet (nichts wird irgendwohin gesendet). Ein optionaler KI-gestützter Modus kann weitere Felder ausfüllen, sobald du ihn unter Konto → Datenschutz aktivierst.',
        'Dokumentvorlagen — Lebenslauf, Anschreiben, Interview-Checkliste und mehr, jetzt mit Vorschau in der App und Export als PDF, Word-freundlicher Text oder Markdown, in deiner Sprache.',
        'Verbessertes öffentliches Profil — Besucher können Sprache und Theme wechseln, finden einen Link zurück zu InternshipCRM und können dir direkt eine Nachricht senden (spamgeschützt).',
        'Fähigkeitsbewertung — bewerte deine Fähigkeiten mit einer einfachen 1–5-Sterne-Auswahl statt eines Dropdowns.',
        'Zahlreiche Verbesserungen am Dunkelmodus und an der Navigation in der gesamten App.',
      ],
    },
  },
  {
    version: '0.1.0',
    date: '2026-01-01',
    highlights: {
      en: [
        'The original platform: mentor–mentee pipeline tracking, role-based dashboards for admins, mentors, mentees and companies, interaction logging, analytics, document uploads, two-factor authentication, and multi-language support (EN/TR/DE).',
        'This is a retroactive summary — detailed release notes start with 0.2.0-beta.',
      ],
      tr: [
        'Orijinal platform: mentor–mentee süreç takibi, admin/mentör/mentee/şirket için rol bazlı panolar, etkileşim kaydı, analitik, doküman yükleme, iki faktörlü kimlik doğrulama ve çok dilli destek (EN/TR/DE).',
        'Bu geriye dönük bir özettir — detaylı sürüm notları 0.2.0-beta ile başlar.',
      ],
      de: [
        'Die ursprüngliche Plattform: Mentor-Mentee-Pipeline-Tracking, rollenbasierte Dashboards für Admins, Mentoren, Mentees und Unternehmen, Interaktionsprotokolle, Analysen, Dokument-Uploads, Zwei-Faktor-Authentifizierung und mehrsprachige Unterstützung (EN/TR/DE).',
        'Dies ist eine rückwirkende Zusammenfassung — detaillierte Versionshinweise beginnen mit 0.2.0-beta.',
      ],
    },
  },
];

export const LATEST_RELEASE_VERSION = RELEASE_NOTES[0]?.version ?? '0.0.0';
