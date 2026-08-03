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
    version: '0.40.8-beta',
    date: '2026-08-03',
    highlights: {
      en: [
        'A small notes window you can open from your notes page. On Chrome and Edge it stays on top of everything — even other apps — so you can write during a call without hunting for the right tab. Other browsers get the same window, just not pinned on top, and it tells you so.',
        'It saves itself while you type, saves again when you close it, and keeps a copy on your device in case a save fails — so notes do not get lost.',
        'Notes taken during a meeting now remember which meeting they belong to, and show its name. Deleting the meeting never deletes the notes.',
      ],
      tr: [
        'Notlar sayfandan açabileceğin küçük bir not penceresi. Chrome ve Edge\'de her şeyin — diğer uygulamaların bile — üstünde duruyor; görüşme sırasında doğru sekmeyi aramadan yazabiliyorsun. Diğer tarayıcılarda aynı pencere açılıyor, sadece üstte sabitlenmiyor ve bunu sana söylüyor.',
        'Sen yazarken kendini kaydediyor, kapatırken bir daha kaydediyor ve kayıt başarısız olursa bir kopyayı cihazında tutuyor — notlar kaybolmuyor.',
        'Görüşme sırasında alınan notlar artık hangi görüşmeye ait olduklarını hatırlıyor ve adını gösteriyor. Görüşmeyi silmek notları asla silmiyor.',
      ],
      de: [
        'Ein kleines Notizfenster, das du auf deiner Notizseite öffnen kannst. In Chrome und Edge bleibt es über allem — auch über anderen Programmen — sodass du während eines Gesprächs schreiben kannst, ohne den richtigen Tab zu suchen. Andere Browser bekommen dasselbe Fenster, nur nicht im Vordergrund fixiert, und sagen dir das auch.',
        'Es speichert sich beim Tippen, speichert beim Schließen noch einmal und behält eine Kopie auf deinem Gerät, falls das Speichern fehlschlägt — so gehen Notizen nicht verloren.',
        'Während einer Besprechung erfasste Notizen merken sich jetzt, zu welcher sie gehören, und zeigen deren Namen. Das Löschen der Besprechung löscht die Notizen nie mit.',
      ],
    },
  },
  {
    version: '0.40.7-beta',
    date: '2026-08-03',
    highlights: {
      en: [
        'The same one-click meeting now works for a whole project team: a button on the project page, next to the weekly meeting. Everyone on the team gets the link — you no longer invite people one at a time.',
        'And from a group chat: start a call and the link is posted straight into the conversation, so anyone reading the thread can just tap it.',
        'Who may start one follows who runs the space: project owners and mentors for a team call, and any participant of a chat for a chat call.',
      ],
      tr: [
        'Aynı tek tıklık görüşme artık bütün bir proje ekibi için de var: proje sayfasında, haftalık toplantının yanında bir buton. Link ekipteki herkese gidiyor — kişileri tek tek davet etmene gerek kalmıyor.',
        'Grup sohbetinden de olur: görüşmeyi başlat, link doğrudan konuşmaya düşsün; sohbeti okuyan herkes tıklayıp katılsın.',
        'Kimin başlatabileceği, o alanı kimin yürüttüğüne göre: ekip görüşmesini proje sahipleri ve mentörler, sohbet görüşmesini o sohbetteki herkes başlatabiliyor.',
      ],
      de: [
        'Dieselbe Ein-Klick-Besprechung gibt es jetzt für ein ganzes Projektteam: eine Schaltfläche auf der Projektseite, neben der wöchentlichen Besprechung. Alle im Team bekommen den Link — niemand muss mehr einzeln eingeladen werden.',
        'Und aus einem Gruppenchat heraus: Besprechung starten, und der Link landet direkt im Gespräch, sodass alle Mitlesenden einfach darauf tippen können.',
        'Wer starten darf, richtet sich danach, wer den Raum führt: Projekt-Eigentümer und Mentoren für einen Teamanruf, und jede teilnehmende Person eines Chats für einen Chat-Anruf.',
      ],
    },
  },
  {
    version: '0.40.6-beta',
    date: '2026-08-03',
    highlights: {
      en: [
        'Start a meeting in one click, from wherever the person already is: a "Start meeting" button now sits on every mentee card, on the candidate page and on the meetings screen. You are asked one thing — what it is about — and that is it.',
        'The room then opens beside your work instead of stealing a tab: the invitee gets the link straight away by notification and email, the link is copied to your clipboard, and you can keep clicking around the app without dropping the call.',
        'On a phone the panel becomes a simple Join button, and a link we cannot show inside the app offers to open in a new tab instead of showing you an empty box.',
      ],
      tr: [
        'Görüşmeyi tek tıkla, kişinin zaten bulunduğu yerden başlat: artık her mentee kartında, aday sayfasında ve toplantılar ekranında bir "Görüşme başlat" butonu var. Sana tek bir şey soruluyor — konu ne — hepsi bu.',
        'Oda sekmeni çalmak yerine işinin yanında açılıyor: karşı taraf linki anında bildirim ve e-posta ile alıyor, link panona kopyalanıyor ve uygulamada gezinmeye devam etsen de görüşme düşmüyor.',
        'Telefonda panel sade bir "Katıl" butonuna dönüşüyor; uygulama içinde gösteremediğimiz bir link için boş kutu yerine yeni sekmede açma seçeneği çıkıyor.',
      ],
      de: [
        'Eine Besprechung mit einem Klick starten — dort, wo die Person ohnehin steht: Eine Schaltfläche „Besprechung starten“ gibt es jetzt auf jeder Mentee-Karte, auf der Kandidatenseite und im Besprechungsbereich. Gefragt wird nur eines: worum es geht.',
        'Der Raum öffnet sich dann neben deiner Arbeit, statt einen Tab zu belegen: Die eingeladene Person erhält den Link sofort per Benachrichtigung und E-Mail, der Link liegt in deiner Zwischenablage, und du kannst weiter in der App navigieren, ohne das Gespräch zu verlieren.',
        'Auf dem Handy wird das Panel zu einer einfachen „Teilnehmen“-Schaltfläche; einen Link, den wir nicht in der App anzeigen können, bieten wir zum Öffnen in einem neuen Tab an, statt ein leeres Feld zu zeigen.',
      ],
    },
  },
  {
    version: '0.40.5-beta',
    date: '2026-08-03',
    highlights: {
      en: [
        'Groundwork for starting a meeting on the spot: the server can now open a room and hand back the link in one step, instead of making the page look it up afterwards. A meeting can also belong to a whole project or a group chat, not just to one mentorship. Nothing new on screen yet — the buttons come next.',
      ],
      tr: [
        'Anında görüşme başlatmanın altyapısı: sunucu artık odayı açıp linki tek adımda geri veriyor, sayfanın sonradan aramasına gerek kalmıyor. Bir görüşme artık tek bir mentorluğa değil, bütün bir projeye ya da grup sohbetine de ait olabiliyor. Ekranda henüz yeni bir şey yok — butonlar sırada.',
      ],
      de: [
        'Grundlage für das sofortige Starten einer Besprechung: Der Server öffnet den Raum jetzt und gibt den Link in einem Schritt zurück, statt die Seite ihn nachträglich suchen zu lassen. Eine Besprechung kann außerdem zu einem ganzen Projekt oder einem Gruppenchat gehören, nicht nur zu einer Mentorschaft. Auf dem Bildschirm ist noch nichts Neues zu sehen — die Schaltflächen folgen.',
      ],
    },
  },
  {
    version: '0.40.4-beta',
    date: '2026-08-03',
    highlights: {
      en: [
        'Important fix: a meeting you scheduled was saved at the wrong time unless your clock happened to match UTC. Picking 16:30 in Germany created an 18:30 meeting — the time jumped forward by your own time-zone offset, and that wrong time is what the invitation and the reminder email told everyone. The time you pick is now the time that gets saved, wherever you are, summer time included.',
        'Meetings you give a date but no time to now sit on that date on the calendar for everyone, instead of slipping to the day before for anyone west of London.',
        'Meetings created before this fix keep their shifted time — please check any upcoming meeting you scheduled earlier and set it up again if the time is off.',
      ],
      tr: [
        'Önemli düzeltme: planladığın toplantı, saatin UTC ile aynı olmadığı her durumda yanlış saatte kaydediliyordu. Almanya\'da 16:30 seçmek 18:30\'luk bir toplantı oluşturuyordu — saat kendi saat dilimi farkın kadar ileri kayıyordu ve davet ile hatırlatma e-postası herkese bu yanlış saati söylüyordu. Artık seçtiğin saat, nerede olursan ol (yaz saati dahil) kaydedilen saat.',
        'Tarih verip saat vermediğin toplantılar artık takvimde herkes için o tarihte duruyor; Londra\'nın batısındakiler için bir gün öncesine kaymıyor.',
        'Bu düzeltmeden önce oluşturulan toplantıların saati kayık kalıyor — daha önce planladığın yaklaşan toplantıları kontrol et ve saati yanlışsa yeniden oluştur.',
      ],
      de: [
        'Wichtige Korrektur: Ein von dir geplantes Meeting wurde zur falschen Zeit gespeichert, sofern deine Uhr nicht ohnehin UTC entsprach. Wer in Deutschland 16:30 wählte, bekam ein Meeting um 18:30 — die Zeit sprang um deinen eigenen Zeitzonen-Versatz nach vorn, und genau diese falsche Zeit stand in der Einladung und in der Erinnerungs-E-Mail. Jetzt wird die Zeit gespeichert, die du auswählst — überall, Sommerzeit inklusive.',
        'Meetings mit Datum, aber ohne Uhrzeit liegen im Kalender nun für alle an diesem Datum, statt für alle westlich von London auf den Vortag zu rutschen.',
        'Vor dieser Korrektur erstellte Meetings behalten ihre verschobene Zeit — prüfe bitte deine bereits geplanten kommenden Meetings und lege sie bei falscher Zeit neu an.',
      ],
    },
  },
  {
    version: '0.40.3-beta',
    date: '2026-08-03',
    highlights: {
      en: [
        'Maintenance only: the new "who referred them" and project member pickers made three automated tests ambiguous, because an option in a dropdown is text like any other. Nothing changed on screen.',
      ],
      tr: [
        'Yalnızca bakım: yeni "getiren kişi" ve proje üye seçicileri, üç otomatik testi belirsiz hale getirmişti — açılır listedeki bir seçenek de sonuçta metin. Ekranda değişen bir şey yok.',
      ],
      de: [
        'Nur Wartung: Die neuen Auswahlfelder „wer hat sie geworben“ und für Projektmitglieder machten drei automatisierte Tests mehrdeutig — eine Option in einem Dropdown ist auch nur Text. Auf dem Bildschirm ändert sich nichts.',
      ],
    },
  },
  {
    version: '0.40.2-beta',
    date: '2026-08-02',
    highlights: {
      en: [
        'Setting up a recurring meeting used to email everyone once for every future occurrence — dozens of near-identical invitations from a single click. Now only the next meeting is announced; every one after that is covered by the reminder a day before and an hour before.',
        'Those reminders were also being sent twice to anyone who had both a mentorship and a project membership. One reminder now, to the whole project team.',
        'The project page shows the app header again, so on a phone you still see where you are and can get back to your dashboard.',
      ],
      tr: [
        'Düzenli toplantı tanımlayınca gelecekteki her tekrar için herkese ayrı e-posta gidiyordu — tek tıkla onlarca benzer davet. Artık sadece bir sonraki toplantı duyuruluyor; sonrakiler için bir gün önce ve bir saat önce gelen hatırlatma yeterli.',
        'Bu hatırlatmalar, hem mentorluğu hem proje üyeliği olan kişilere iki kez gidiyordu. Artık tek hatırlatma, projedeki herkese.',
        'Proje sayfasında uygulama başlığı yeniden görünüyor; mobilde nerede olduğunu görüyor ve panele geri dönebiliyorsun.',
      ],
      de: [
        'Beim Anlegen eines wiederkehrenden Treffens ging bisher für jeden künftigen Termin eine eigene E-Mail an alle — Dutzende fast identischer Einladungen mit einem Klick. Jetzt wird nur das nächste Treffen angekündigt; für alle weiteren genügen die Erinnerungen einen Tag und eine Stunde vorher.',
        'Diese Erinnerungen gingen außerdem doppelt an alle, die sowohl eine Mentorschaft als auch eine Projektmitgliedschaft haben. Jetzt eine Erinnerung, an das ganze Projektteam.',
        'Die Projektseite zeigt wieder die App-Kopfzeile — auf dem Handy siehst du also, wo du bist, und kommst zurück zu deinem Dashboard.',
      ],
    },
  },
  {
    version: '0.40.1-beta',
    date: '2026-08-02',
    highlights: {
      en: [
        'A project now has one screen instead of two. The card in the project list is a summary — who is on it, progress, links — and everything else (team, goals, the recurring meeting, join requests, adding people) is on the project page. If your account is both admin and mentor you reach that list from two places, which is why two half-views used to alternate.',
        'The phone layout of those screens was reworked: the old "add a task" box that shrank to a sliver is gone, and the goal, meeting and member forms now stack instead of squeezing into one row.',
      ],
      tr: [
        'Bir projenin artık iki değil tek ekranı var. Proje listesindeki kart bir özet — kimler var, ilerleme, linkler — geri kalan her şey (ekip, hedefler, düzenli toplantı, katılma talepleri, kişi ekleme) proje sayfasında. Hesabın hem admin hem mentörse o listeye iki yerden ulaşıyorsun; iki yarım görünümün dönüşümlü çıkmasının sebebi buydu.',
        'Bu ekranların mobil düzeni yenilendi: incecik kalan eski "görev ekle" kutusu kaldırıldı; hedef, toplantı ve üye formları tek satıra sıkışmak yerine alt alta diziliyor.',
      ],
      de: [
        'Ein Projekt hat jetzt einen Bildschirm statt zwei. Die Karte in der Projektliste ist eine Zusammenfassung — wer dabei ist, Fortschritt, Links — alles andere (Team, Ziele, wiederkehrendes Treffen, Beitrittsanfragen, Personen hinzufügen) liegt auf der Projektseite. Wer sowohl Admin als auch Mentor ist, erreicht diese Liste über zwei Wege; daher wechselten sich bisher zwei halbe Ansichten ab.',
        'Das Handy-Layout dieser Seiten wurde überarbeitet: Das alte, auf wenige Pixel geschrumpfte „Aufgabe hinzufügen“-Feld ist weg, und die Formulare für Ziele, Treffen und Mitglieder stapeln sich statt sich in eine Zeile zu quetschen.',
      ],
    },
  },
  {
    version: '0.40.0-beta',
    date: '2026-08-02',
    highlights: {
      en: [
        'A project now shows the people who are actually on it. The roster comes from the members you add, each with what they do (developer, tester, marketing), so the old "2 interns" line with two unrelated names is gone.',
        'If you work on a project, you see the project. Members — mentees included — get the team list, the goals and the recurring meeting instead of the anonymous visitor page, and a private project you were added to is no longer invisible to you.',
        'The recurring meeting has a home: an owner sets the days, the time and the link, everyone on the project reads it, and reminders go out a day before and an hour before — in the app, and by email unless you switched meeting emails off.',
        'Goals belong to someone. Your own goals are yours to tick off, an unclaimed project goal can be taken with one click, and a mentor can hand the standard starter goals to whoever joined last: every goal ever written on the project is kept as a template.',
        'Public projects accept join requests. Ask to join, say what you would like to do, and the project owner (or an admin) approves — which is also what adds you to the project and its group chat.',
        'Group chats say who is in the room, with each person\'s role on the project, and link back to the project.',
        'Shortcuts where you need them: message the project owner or open the group chat from the project, send a message from someone\'s profile, and — for admins — view the app as them from the same place.',
        'Invite links now connect people. An admin can pick the mentor a new mentee should be paired with (or the mentee for a new mentor) and a project to join; the connection exists the moment the person registers. Mentees, mentors and admins each also get a personal link to share with their circle, and whoever signs up through it is recorded as having come from them.',
        'Mentors get an onboarding checklist when someone new joins: say hello, book the kick-off, add them to a project, send the starter goals, move them along the pipeline. Steps the app can see tick themselves.',
      ],
      tr: [
        'Bir proje artık gerçekten içinde olan kişileri gösteriyor. Ekip, eklediğin üyelerden geliyor ve herkesin ne yaptığı (geliştirici, tester, pazarlama) yanında yazıyor; eski "2 stajyer" satırı ve alakasız iki isim tarih oldu.',
        'Bir projede çalışıyorsan projeyi görüyorsun. Üyeler — mentee’ler dahil — ziyaretçi görünümü yerine ekibi, hedefleri ve düzenli toplantıyı görüyor; eklendiğin özel bir proje artık sana kapalı değil.',
        'Düzenli toplantının yeri var: proje sahibi günleri, saati ve linki tanımlıyor, projedeki herkes bunu görüyor ve hatırlatmalar bir gün önce ve bir saat önce gidiyor — uygulama içinde, toplantı e-postalarını kapatmadıysan e-posta ile de.',
        'Hedefler artık bir kişiye ait. Kendi hedeflerini sen işaretliyorsun, sahipsiz bir proje hedefini tek tıkla üstlenebiliyorsun ve mentör, standart başlangıç hedeflerini en son katılan kişiye tek seferde gönderebiliyor: projede yazılmış her hedef şablon olarak saklanıyor.',
        'Açık projeler katılma talebi alıyor. Katılmak istediğini ve ne yapmak istediğini yazıyorsun; proje sahibi (ya da bir admin) onaylıyor — bu onay aynı zamanda seni projeye ve grup sohbetine ekliyor.',
        'Grup sohbetleri artık içinde kimlerin olduğunu, herkesin projedeki rolüyle gösteriyor ve projeye geri link veriyor.',
        'Kısayollar gerektiği yerde: projeden proje sahibine mesaj ya da grup sohbeti, bir kişinin profilinden mesaj gönderme ve adminler için aynı yerden "bu kullanıcı olarak görüntüle".',
        'Davet linkleri artık bağlantı kuruyor. Admin, yeni bir mentee’nin hangi mentöre bağlanacağını (ya da yeni bir mentörün hangi mentee’yi alacağını) ve katılacağı projeyi seçebiliyor; kişi kaydolduğu anda bağlantı kurulmuş oluyor. Ayrıca mentee, mentör ve adminlerin çevresine paylaşacağı kişisel bir linki var; o linkle gelen herkesin kaynağı o kişi olarak kaydediliyor.',
        'Yeni biri katıldığında mentöre bir onboarding listesi çıkıyor: merhaba de, tanışma toplantısını ayarla, projeye ekle, başlangıç hedeflerini gönder, pipeline’da ilerlet. Uygulamanın görebildiği adımlar kendiliğinden işaretleniyor.',
      ],
      de: [
        'Ein Projekt zeigt jetzt die Menschen, die wirklich daran arbeiten. Das Team kommt aus den Mitgliedern, die du hinzufügst — jeweils mit ihrer Aufgabe (Entwicklung, Test, Marketing). Die alte Zeile „2 Praktikanten“ mit zwei unbeteiligten Namen ist weg.',
        'Wer an einem Projekt arbeitet, sieht das Projekt. Mitglieder — auch Mentees — bekommen Team, Ziele und das wiederkehrende Treffen statt der Besucheransicht, und ein privates Projekt, zu dem du hinzugefügt wurdest, ist für dich nicht mehr unsichtbar.',
        'Das wiederkehrende Treffen hat einen Platz: Der Owner legt Tage, Zeit und Link fest, alle im Projekt sehen das, und Erinnerungen gehen einen Tag vorher und eine Stunde vorher raus — in der App und per E-Mail, sofern du Meeting-E-Mails nicht deaktiviert hast.',
        'Ziele gehören jemandem. Deine eigenen Ziele hakst du selbst ab, ein freies Projektziel kannst du mit einem Klick übernehmen, und eine Mentorin kann die Standard-Startziele an die zuletzt hinzugekommene Person schicken: Jedes je formulierte Ziel wird als Vorlage aufbewahrt.',
        'Öffentliche Projekte nehmen Beitrittsanfragen an. Du fragst an und sagst, was du machen möchtest; der Owner (oder eine Administratorin) gibt frei — und genau das fügt dich zum Projekt und seinem Gruppenchat hinzu.',
        'Gruppenchats zeigen, wer im Raum ist — mit der jeweiligen Rolle im Projekt — und verlinken zurück zum Projekt.',
        'Shortcuts da, wo man sie braucht: aus dem Projekt den Owner anschreiben oder den Gruppenchat öffnen, aus einem Profil eine Nachricht senden und — für Admins — von dort die App als diese Person ansehen.',
        'Einladungslinks verbinden jetzt. Eine Administratorin kann wählen, mit welchem Mentor ein neuer Mentee verbunden wird (oder mit welchem Mentee eine neue Mentorin) und welchem Projekt beigetreten wird; die Verbindung besteht mit der Registrierung. Mentees, Mentoren und Admins haben zusätzlich einen persönlichen Link fürs eigene Umfeld — wer sich darüber registriert, wird ihnen als Quelle zugeordnet.',
        'Mentoren bekommen eine Onboarding-Liste, wenn jemand Neues dazukommt: Hallo sagen, Kick-off buchen, zu einem Projekt hinzufügen, Startziele senden, in der Pipeline weiterbewegen. Was die App sehen kann, hakt sich selbst ab.',
      ],
    },
  },
  {
    version: '0.39.1-beta',
    date: '2026-08-02',
    highlights: {
      en: [
        'Two-factor authentication now belongs to the account holder alone. While an admin is viewing your account through "Login as", they can no longer turn 2FA on — which would have paired an authenticator app only they hold — nor turn it off, nor sign your devices out. Those cards are hidden during impersonation and the server refuses the changes even if the request is sent directly.',
        'This also fixes the audit trail: such a change used to be recorded under your name rather than the admin\'s. Admins who need to lock an account out still start a password reset for it from the user list, which is logged as their own action.',
      ],
      tr: [
        'İki faktörlü doğrulama artık yalnızca hesap sahibinin elinde. Bir yönetici "Kullanıcı olarak gir" ile hesabına baktığında 2FA\'yı açamaz (bu, yalnızca onun elindeki bir doğrulayıcı uygulamayı hesabına bağlardı), kapatamaz ve cihazlarından çıkış yaptıramaz. Bu kartlar kimliğe bürünme sırasında gizleniyor; istek doğrudan gönderilse bile sunucu reddediyor.',
        'Bu aynı zamanda denetim kaydını da düzeltiyor: böyle bir değişiklik önce yöneticinin değil senin adına kaydediliyordu. Bir hesabın erişimini kesmesi gereken yöneticiler bunu yine kullanıcı listesinden parola sıfırlama başlatarak yapıyor — o işlem kendi adlarına kaydediliyor.',
      ],
      de: [
        'Die Zwei-Faktor-Authentifizierung gehört jetzt allein dem Kontoinhaber. Solange eine Administratorin dein Konto per „Anmelden als“ ansieht, kann sie 2FA weder aktivieren — das hätte eine Authenticator-App eingerichtet, die nur sie besitzt — noch deaktivieren, noch deine Geräte abmelden. Diese Karten sind während der Identitätsübernahme ausgeblendet, und der Server lehnt die Änderungen auch bei direkt gesendeten Anfragen ab.',
        'Damit stimmt auch das Protokoll wieder: Eine solche Änderung wurde bisher unter deinem Namen statt unter dem der Administratorin festgehalten. Wer ein Konto aussperren muss, startet dafür weiterhin aus der Nutzerliste ein Passwort-Zurücksetzen — das wird als eigene Aktion protokolliert.',
      ],
    },
  },
  {
    version: '0.39.0-beta',
    date: '2026-08-02',
    highlights: {
      en: [
        'Admins can now delete a user account from the user list. Open Users, pick a row and choose "Erase account" — candidates can also be anonymized instead, which keeps their pipeline history but removes every personal detail. Deleting someone else\'s account no longer requires knowing their password: you confirm with your own, plus typing the account holder\'s exact name.',
        'Deletions are recorded with the name and role of the erased account and the admin who did it, so there is still a trace once the account itself is gone. Admin accounts cannot be erased this way — change the role first, or let the owner delete their own account.',
      ],
      tr: [
        'Yöneticiler artık bir kullanıcı hesabını kullanıcı listesinden silebiliyor. Kullanıcılar sayfasında ilgili satırdaki "Hesabı sil" seçeneğini kullan; adaylar için silme yerine anonimleştirme de var (süreç geçmişi kalır, kişisel bilgiler temizlenir). Başkasının hesabını silmek için onun parolasını bilmen gerekmiyor: kendi parolanla onaylıyorsun, ayrıca hesap sahibinin adını tam olarak yazıyorsun.',
        'Silme işlemleri; silinen hesabın adı, rolü ve işlemi yapan yönetici ile birlikte kaydediliyor — hesap gittikten sonra da bir iz kalıyor. Yönetici hesapları bu yolla silinemez; önce rolünü değiştir ya da hesap sahibi kendi hesabını silsin.',
      ],
      de: [
        'Administratoren können ein Benutzerkonto jetzt direkt aus der Nutzerliste löschen. Unter Benutzer in der jeweiligen Zeile „Konto löschen“ wählen — Kandidaten lassen sich alternativ anonymisieren: die Pipeline-Historie bleibt, alle persönlichen Angaben verschwinden. Für das Löschen eines fremden Kontos ist dessen Passwort nicht mehr nötig: du bestätigst mit deinem eigenen und tippst den genauen Namen des Kontoinhabers.',
        'Jede Löschung wird mit Name und Rolle des gelöschten Kontos sowie der ausführenden Administratorin protokolliert — es bleibt also eine Spur, wenn das Konto selbst weg ist. Admin-Konten lassen sich so nicht löschen: erst die Rolle ändern, oder der Inhaber löscht sein Konto selbst.',
      ],
    },
  },
  {
    version: '0.38.4-beta',
    date: '2026-08-02',
    highlights: {
      en: [
        'The account page no longer offers dead controls while you are viewing someone else\'s account as an admin. "Change e-mail", "Change password" and "Delete account" asked for the account holder\'s current password — which an admin cannot know, and which the server rejected in any case. Those cards are now hidden during impersonation, with a note explaining where account deletion belongs. In your own account nothing changes.',
      ],
      tr: [
        'Bir hesabı yönetici olarak görüntülerken hesap sayfası artık çalışmayan seçenekler göstermiyor. "E-postayı değiştir", "Parolayı değiştir" ve "Hesabı sil" hesap sahibinin mevcut parolasını istiyordu; yöneticinin bilemeyeceği ve sunucunun zaten kabul etmediği bir parola. Bu kartlar kimliğe bürünme sırasında artık gizli ve yerine hesap silmenin nereden yapılacağını anlatan bir not var. Kendi hesabında hiçbir şey değişmiyor.',
      ],
      de: [
        'Die Kontoseite zeigt keine funktionslosen Aktionen mehr, wenn du ein Konto als Admin ansiehst. „E-Mail ändern“, „Passwort ändern“ und „Konto löschen“ verlangten das aktuelle Passwort des Kontoinhabers — das ein Admin nicht kennen kann und das der Server ohnehin abgelehnt hat. Diese Karten sind während der Identitätsübernahme jetzt ausgeblendet, mit einem Hinweis, wo das Löschen eines Kontos hingehört. Im eigenen Konto ändert sich nichts.',
      ],
    },
  },
  {
    version: '0.38.3-beta',
    date: '2026-08-02',
    highlights: {
      en: [
        'The "You are viewing the app as …" bar now follows you everywhere. On Messages, Account, Notifications and Announcements it used to vanish, so an admin viewing someone else\'s account had no reminder of it — and no "Return to your account" link to get back. It is now a strip at the top of every screen that stays visible while you scroll.',
      ],
      tr: [
        '"Uygulamayı … olarak görüntülüyorsun" çubuğu artık her ekranda görünüyor. Mesajlar, Hesap, Bildirimler ve Duyurular sayfalarında kayboluyordu; başkasının hesabını görüntüleyen bir yönetici bunu hatırlatan bir uyarıyı da, "Kendi hesabına dön" bağlantısını da göremiyordu. Çubuk artık her ekranın en üstünde ve sayfayı kaydırırken de görünür kalıyor.',
      ],
      de: [
        'Die Leiste „Du siehst die App als …“ erscheint jetzt auf jedem Bildschirm. Unter Nachrichten, Konto, Benachrichtigungen und Ankündigungen verschwand sie bisher — eine Administratorin im Konto einer anderen Person sah weder den Hinweis noch den Link „Zu deinem Konto zurückkehren“. Die Leiste sitzt nun oben auf jedem Bildschirm und bleibt beim Scrollen sichtbar.',
      ],
    },
  },
  {
    version: '0.38.2-beta',
    date: '2026-08-02',
    highlights: {
      en: [
        'Meeting reminder emails now show the right time. A meeting at 09:00 in the app arrived as "07:00" in the email, because the times were written on the server\'s clock. Emails and notifications now use your own timezone and spell it out, e.g. "2 Aug 2026, 09:00 (GMT+2)". Nothing was ever scheduled at the wrong time — only the reminder text was misleading.',
        'Your timezone is picked up from your browser automatically if you never set one. Mentees can still choose it by hand under Profile, and a zone you chose yourself is never overwritten.',
      ],
      tr: [
        'Toplantı hatırlatma e-postalarındaki saat artık doğru. Uygulamada 09:00 görünen bir toplantı e-postada "07:00" olarak geliyordu, çünkü saatler sunucunun saatiyle yazılıyordu. E-postalar ve bildirimler artık sizin saat diliminizi kullanıyor ve bunu açıkça yazıyor: örneğin "2 Aug 2026, 09:00 (GMT+2)". Toplantılar hiçbir zaman yanlış saate kurulmadı — yalnızca hatırlatma metni yanıltıcıydı.',
        'Hiç seçmediyseniz saat diliminiz tarayıcınızdan otomatik olarak alınır. Mentee’ler Profil sayfasından elle de seçebilir; kendi seçtiğiniz saat dilimi hiçbir zaman üzerine yazılmaz.',
      ],
      de: [
        'Erinnerungs-E-Mails zu Terminen zeigen jetzt die richtige Uhrzeit. Ein Termin, den die App um 09:00 anzeigte, kam in der E-Mail als „07:00“ an, weil die Zeiten auf der Uhr des Servers geschrieben wurden. E-Mails und Benachrichtigungen verwenden nun Ihre eigene Zeitzone und nennen sie ausdrücklich, z. B. „2 Aug 2026, 09:00 (GMT+2)“. Kein Termin lag jemals falsch — nur der Erinnerungstext war irreführend.',
        'Ihre Zeitzone wird automatisch aus dem Browser übernommen, falls Sie nie eine gesetzt haben. Mentees können sie im Profil weiterhin selbst wählen; eine selbst gewählte Zone wird nie überschrieben.',
      ],
    },
  },
  {
    version: '0.38.1-beta',
    date: '2026-08-01',
    highlights: {
      en: [
        'Availability: the "Add" button now works for admins too. Adding a slot did save it, but the list underneath kept showing "Your slots (0)", so it looked like nothing happened. Any slots you added earlier were never lost — they are all visible again.',
      ],
      tr: [
        'Müsaitlik: "Ekle" düğmesi artık yöneticiler için de çalışıyor. Saat aslında kaydediliyordu, ama alttaki liste "Saatlerin (0)" göstermeye devam ettiği için hiçbir şey olmamış gibi görünüyordu. Daha önce eklediğiniz saatler kaybolmadı — hepsi yeniden görünüyor.',
      ],
      de: [
        'Verfügbarkeit: Die Schaltfläche „Hinzufügen“ funktioniert jetzt auch für Admins. Das Zeitfenster wurde zwar gespeichert, die Liste darunter zeigte aber weiterhin „Deine Zeitfenster (0)“ — es sah also aus, als passiere nichts. Früher angelegte Zeitfenster gingen nie verloren und sind wieder sichtbar.',
      ],
    },
  },
  {
    version: '0.38.0-beta',
    date: '2026-08-01',
    highlights: {
      en: [
        'An evaluation you added by mistake can now be deleted: click the trash icon on the entry in the evaluation list. You can only remove evaluations you wrote yourself — admins can remove any — so nobody can erase an evaluation written about them.',
      ],
      tr: [
        'Yanlışlıkla eklediğiniz bir değerlendirmeyi artık silebilirsiniz: değerlendirme listesindeki kaydın üzerindeki çöp kutusu simgesine tıklayın. Yalnızca kendi yazdığınız değerlendirmeleri silebilirsiniz (yöneticiler hepsini silebilir), böylece kimse hakkında yazılan bir değerlendirmeyi kaldıramaz.',
      ],
      de: [
        'Eine versehentlich eingetragene Bewertung lässt sich jetzt löschen: einfach auf das Papierkorb-Symbol beim Eintrag in der Bewertungsliste klicken. Löschen können Sie nur Ihre eigenen Bewertungen — Admins alle —, damit niemand eine Bewertung über sich selbst entfernen kann.',
      ],
    },
  },
  {
    version: '0.37.0-beta',
    date: '2026-08-01',
    highlights: {
      en: [
        'Admins who also mentor can now switch the whole app into the mentor view and back, from a new "View as" control at the bottom of the sidebar. Mentor view shows only the mentees you mentor yourself, without the org-wide admin pages — handy for actually working with your own mentees instead of reading the dense admin screens.',
        'The switch keeps your place: from the admin board you land on the mentor board, from the candidate list on your own mentees, and so on. Pages that exist only for admins take you to the mentor dashboard instead.',
      ],
      tr: [
        'Aynı zamanda mentorluk yapan yöneticiler artık uygulamayı tümüyle mentor görünümüne alıp geri dönebilir; kenar çubuğunun altındaki yeni "Görünüm" düğmesiyle. Mentor görünümü, kurum genelindeki yönetim sayfaları olmadan yalnızca kendi mentorluk yaptığınız mentee’leri gösterir — yoğun yönetim ekranlarıyla uğraşmak yerine kendi mentee’lerinizle çalışmak için pratik bir yol.',
        'Düğme bulunduğunuz yeri korur: yönetici panosundan mentor panosuna, aday listesinden kendi mentee’lerinize geçersiniz. Yalnızca yöneticilere özel sayfalarda ise mentor paneline yönlendirilirsiniz.',
      ],
      de: [
        'Admins, die selbst mentorieren, können die App jetzt komplett in die Mentoren-Ansicht umschalten und zurück — über das neue Feld „Ansicht“ unten in der Seitenleiste. Die Mentoren-Ansicht zeigt nur die Mentees, die Sie selbst betreuen, ohne die organisationsweiten Admin-Seiten.',
        'Der Umschalter behält Ihren Kontext: vom Admin-Board landen Sie auf dem Mentoren-Board, von der Kandidatenliste bei Ihren eigenen Mentees. Seiten, die es nur für Admins gibt, führen stattdessen zum Mentoren-Dashboard.',
      ],
    },
  },
  {
    version: '0.36.0-beta',
    date: '2026-08-01',
    highlights: {
      en: [
        'Mentors now have the same global search as admins, right in the header — find one of your mentees by name or email and jump straight to their profile.',
      ],
      tr: [
        'Mentorlar artık adminlerle aynı genel aramaya, üst menüden erişebiliyor — mentilerinden birini ad veya e-postayla bulup doğrudan profiline gidebilirsiniz.',
      ],
      de: [
        'Mentoren haben jetzt dieselbe globale Suche wie Admins, direkt in der Kopfzeile — finde einen deiner Mentees per Name oder E-Mail und springe direkt zu seinem Profil.',
      ],
    },
  },
  {
    version: '0.35.3-beta',
    date: '2026-08-01',
    highlights: {
      en: [
        'You can now paste an image straight into an announcement, just like in messages — take a screenshot, press paste in the message box, and it is attached. Choosing a file from disk still works as before.',
      ],
      tr: [
        'Artık duyuruya doğrudan görsel yapıştırabilirsiniz, tıpkı mesajlardaki gibi — ekran görüntüsünü alıp mesaj kutusunda yapıştırın, görsel eklenir. Dosya seçerek eklemek de eskisi gibi çalışıyor.',
      ],
      de: [
        'Sie können ein Bild jetzt direkt in eine Ankündigung einfügen, genau wie in Nachrichten — Screenshot machen, im Nachrichtenfeld einfügen, fertig. Eine Datei auszuwählen funktioniert weiterhin wie bisher.',
      ],
    },
  },
  {
    version: '0.35.2-beta',
    date: '2026-08-01',
    highlights: {
      en: [
        'Fixed the bottom edge of the message screens on a phone: the reply box (and the last row of your conversation list) could end up behind the system navigation bar, with no way to scroll it into view. The screen now ends exactly where the visible area ends.',
      ],
      tr: [
        'Telefonda mesaj ekranlarının alt kenarı düzeltildi: cevap kutusu (ve sohbet listesinin son satırı) sistemin gezinme çubuğunun arkasında kalabiliyordu ve kaydırarak görünür hâle getirmek mümkün olmuyordu. Ekran artık tam olarak görünür alanın bittiği yerde bitiyor.',
      ],
      de: [
        'Der untere Rand der Nachrichten-Bildschirme auf dem Handy ist korrigiert: Das Antwortfeld (und die letzte Zeile der Unterhaltungsliste) konnte hinter der System-Navigationsleiste liegen, ohne sich ins Bild scrollen zu lassen. Der Bildschirm endet jetzt genau dort, wo der sichtbare Bereich endet.',
      ],
    },
  },
  {
    version: '0.35.1-beta',
    date: '2026-08-01',
    highlights: {
      en: [
        'The talent pool now tells you whether it is still loading, your search has no matches, or no candidates have joined the pool yet. Empty searches also suggest changing or clearing the filters.',
        'Messages now fill the screen on a phone. A conversation used to be a long page you had to scroll down before you could even reach the reply box — now the message list is the only thing that scrolls, and the reply box stays where it is at the bottom of the screen.',
        'Every message screen also has a header on a phone: it shows who you are talking to, with a back arrow to your conversations and a home button — no more relying on the browser\'s back button to get out.',
        'When the on-screen keyboard opens, the reply box stays visible above it instead of disappearing behind it.',
      ],
      tr: [
        'Yetenek havuzu artık hâlâ yükleniyor mu, aramanızla eşleşen aday mı yok, yoksa havuza henüz hiç aday mı katılmamış açıkça gösteriyor. Sonuçsuz aramalarda filtreleri değiştirme veya temizleme önerisi de sunuluyor.',
        'Mesajlar telefonda artık ekranı tam kullanıyor. Bir sohbet, cevap kutusuna ulaşmak için önce aşağı kaydırmanız gereken uzun bir sayfaydı — artık yalnızca mesaj listesi kayıyor, cevap kutusu ekranın altında sabit duruyor.',
        'Her mesaj ekranında telefonda bir başlık çubuğu var: kiminle konuştuğunuzu gösteriyor, geri okuyla sohbetlerinize, ev butonuyla ana ekranınıza dönüyorsunuz — çıkmak için tarayıcının geri tuşuna ihtiyaç kalmadı.',
        'Ekran klavyesi açıldığında cevap kutusu klavyenin arkasında kaybolmuyor, üstünde görünür kalıyor.',
      ],
      de: [
        'Der Talentpool zeigt jetzt klar, ob er noch lädt, die Suche keine Treffer hat oder noch keine Kandidaten im Pool sind. Bei einer erfolglosen Suche wird außerdem empfohlen, die Filter zu ändern oder zu löschen.',
        'Nachrichten nutzen auf dem Handy jetzt den ganzen Bildschirm. Eine Unterhaltung war eine lange Seite, die man erst nach unten scrollen musste, um überhaupt das Antwortfeld zu erreichen — jetzt scrollt nur noch die Nachrichtenliste, und das Antwortfeld bleibt unten am Bildschirm stehen.',
        'Jeder Nachrichten-Bildschirm hat auf dem Handy außerdem eine Kopfzeile: Sie zeigt, mit wem du schreibst, mit einem Zurück-Pfeil zu deinen Unterhaltungen und einer Start-Schaltfläche — der Zurück-Button des Browsers ist nicht mehr der einzige Ausweg.',
        'Wenn die Bildschirmtastatur aufgeht, bleibt das Antwortfeld darüber sichtbar statt dahinter zu verschwinden.',
      ],
    },
  },
  {
    version: '0.35.0-beta',
    date: '2026-08-01',
    highlights: {
      en: [
        'Announcements can now include an image. When you write an announcement you can attach a picture (PNG, JPEG, WebP or GIF, up to 5 MB) and see it before publishing; everyone sees it with the announcement, and it is included in the email version too.',
      ],
      tr: [
        'Duyurulara artık görsel eklenebiliyor. Duyuru yazarken bir görsel ekleyip (PNG, JPEG, WebP veya GIF, en fazla 5 MB) yayınlamadan önce önizleyebilirsiniz; görsel duyuruyla birlikte herkese gösterilir ve e-posta ile gönderilen sürümde de yer alır.',
      ],
      de: [
        'Ankündigungen können jetzt ein Bild enthalten. Beim Schreiben einer Ankündigung lässt sich ein Bild anhängen (PNG, JPEG, WebP oder GIF, bis zu 5 MB) und vor dem Veröffentlichen ansehen; alle sehen es zusammen mit der Ankündigung, und in der E-Mail-Version ist es ebenfalls enthalten.',
      ],
    },
  },
  {
    version: '0.34.0-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'The pipeline board now works on a phone. Instead of scrolling 13 stage columns sideways, pick a stage and see its mentees as a list — and every card has a "Move to stage" menu, so you no longer need to drag a card (which never worked on touch) to change its stage. Dragging still works on a computer, and a stage change can be undone straight from the confirmation for a few seconds.',
        'The board is also keyboard-friendly: cards can be opened with the keyboard and stages changed without a mouse.',
        'On a phone, the cookie banner no longer covers the "Create Account" button at the bottom of the sign-up page — pages now scroll clear of any bar pinned to the bottom of the screen, so the button is always reachable without dismissing the banner first.',
        'The cookie banner is also more compact on small screens: it used to take up about 40% of the display on a phone.',
      ],
      tr: [
        'Pipeline board artık telefonda çalışıyor. 13 aşama kolonunu yana kaydırmak yerine bir aşama seçip o aşamadaki mentee\'leri liste hâlinde görüyorsunuz; ayrıca her kartta "Aşamaya taşı" menüsü var, yani aşamayı değiştirmek için kartı sürüklemeniz (ki dokunmatikte hiç çalışmıyordu) gerekmiyor. Bilgisayarda sürükleme aynen çalışmaya devam ediyor ve aşama değişikliğini onay bildiriminden birkaç saniye içinde geri alabiliyorsunuz.',
        'Board klavyeyle de kullanılabiliyor: kartlar klavyeyle açılabiliyor, aşamalar fare olmadan değiştirilebiliyor.',
        'Telefonda çerez bandı artık kayıt sayfasının altındaki "Hesap oluştur" butonunu kapatmıyor — sayfalar ekranın altına sabitlenen bantların üstüne kadar kaydırılabiliyor, yani butona ulaşmak için önce bandı kapatmanız gerekmiyor.',
        'Çerez bandı küçük ekranlarda daha derli toplu: eskiden telefonda ekranın yaklaşık %40\'ını kaplıyordu.',
      ],
      de: [
        'Das Pipeline-Board funktioniert jetzt auf dem Handy. Statt 13 Phasenspalten seitwärts zu scrollen, wählst du eine Phase und siehst ihre Mentees als Liste — außerdem hat jede Karte ein Menü „In Phase verschieben", du musst eine Karte also nicht mehr ziehen (was per Touch ohnehin nie funktionierte). Am Computer bleibt das Ziehen unverändert, und ein Phasenwechsel lässt sich für einige Sekunden direkt aus der Bestätigung zurücknehmen.',
        'Das Board ist auch mit der Tastatur bedienbar: Karten lassen sich per Tastatur öffnen und Phasen ohne Maus ändern.',
        'Auf dem Handy verdeckt das Cookie-Banner nicht mehr die Schaltfläche „Konto erstellen" am Ende der Registrierungsseite — Seiten lassen sich jetzt über jede am unteren Bildschirmrand fixierte Leiste hinaus scrollen, die Schaltfläche ist also immer erreichbar, ohne das Banner zuerst zu schließen.',
        'Das Cookie-Banner ist auf kleinen Bildschirmen außerdem kompakter: bisher nahm es auf dem Handy rund 40% der Anzeige ein.',
      ],
    },
  },
  {
    version: '0.33.0-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'Replying by email now works even when you answer from a different address than the one on your account. If your work mail forwards to a personal inbox and you reply from there, your answer used to be dropped without a trace — it now lands in the thread as before, credited to you.',
      ],
      tr: [
        'E-postayla cevaplama artık hesabınızdaki adresten farklı bir adresten yanıtlasanız da çalışıyor. İş mailiniz kişisel bir kutuya yönleniyorsa ve oradan cevap veriyorsanız, cevabınız eskiden iz bırakmadan kayboluyordu — artık eskisi gibi thread\'e düşüyor ve size ait olarak görünüyor.',
      ],
      de: [
        'Antworten per E-Mail funktioniert jetzt auch, wenn du von einer anderen Adresse als der in deinem Konto antwortest. Wenn deine Arbeitsmail an ein privates Postfach weitergeleitet wird und du von dort antwortest, ging deine Antwort früher spurlos verloren — sie landet jetzt wie gewohnt im Thread und wird dir zugeordnet.',
      ],
    },
  },
  {
    version: '0.32.4-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'There is now a Code of Conduct, linked in the footer and available in English, Turkish and German. It sets out what respectful participation looks like for mentees, mentors, admins and company contacts — and what is not acceptable, including misuse of the access a role gives you to someone else’s profile, CV or contact details.',
        'It also explains how to report a problem: confidentially, to an administrator, on your own behalf or someone else’s — and reporting in good faith never counts against you.',
      ],
      tr: [
        'Artık bir Davranış Kuralları metni var; alt bilgiden erişilebiliyor ve İngilizce, Türkçe ve Almanca olarak sunuluyor. Mentee’ler, mentorlar, yöneticiler ve şirket yetkilileri için saygılı katılımın ne demek olduğunu — ve neyin kabul edilemez olduğunu, rolünüzün başkasının profiline, CV’sine veya iletişim bilgilerine verdiği erişimin kötüye kullanımı dâhil — açıkça yazıyor.',
        'Metin ayrıca bir sorunu nasıl bildireceğinizi anlatıyor: gizlilikle, bir yöneticiye, kendi adınıza ya da bir başkası adına. İyi niyetle yapılan bildirim asla aleyhinize kullanılmaz.',
      ],
      de: [
        'Es gibt jetzt einen Verhaltenskodex, verlinkt in der Fußzeile und verfügbar auf Englisch, Türkisch und Deutsch. Er beschreibt, wie respektvolle Teilnahme für Mentees, Mentoren, Admins und Unternehmenskontakte aussieht — und was nicht akzeptabel ist, einschließlich des Missbrauchs des Zugriffs, den eine Rolle auf Profile, Lebensläufe oder Kontaktdaten anderer gibt.',
        'Er erklärt außerdem, wie man ein Problem meldet: vertraulich, an eine Administratorin oder einen Administrator, für sich selbst oder stellvertretend für andere — eine Meldung in gutem Glauben wird Ihnen nie zum Nachteil ausgelegt.',
      ],
    },
  },
  {
    version: '0.32.3-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'Messages: the "New chat" button is back. Since project group chats appeared in the inbox, everyone who was in a project saw no "New chat" option at all — so there was no way to start a private message with someone you share a project with. The people you can write to are listed again.',
      ],
      tr: [
        'Mesajlar: "Yeni sohbet" düğmesi geri geldi. Proje grup sohbetleri gelen kutusuna eklendiğinden beri bir projede yer alan herkes için "Yeni sohbet" seçeneği hiç görünmüyordu — yani aynı projede olduğunuz biriyle özel mesaj başlatmanın yolu yoktu. Yazabileceğiniz kişiler yeniden listeleniyor.',
      ],
      de: [
        'Nachrichten: Die Schaltfläche „Neuer Chat“ ist zurück. Seit die Projekt-Gruppenchats im Posteingang erscheinen, wurde sie allen, die in einem Projekt sind, gar nicht mehr angezeigt — eine private Nachricht an jemanden aus dem eigenen Projekt ließ sich also nicht mehr beginnen. Die möglichen Empfänger werden wieder aufgelistet.',
      ],
    },
  },
  {
    version: '0.32.2-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'Uploads are now checked by their actual contents, not just the file type the browser claims. A file renamed to look like a PDF or an image is rejected.',
        'CVs, documents and file attachments now download instead of opening in the browser, and filenames with accented characters come through correctly.',
      ],
      tr: [
        'Yüklenen dosyalar artık yalnızca tarayıcının bildirdiği türe göre değil, gerçek içeriğine göre denetleniyor. PDF ya da resim gibi görünsün diye adı değiştirilmiş bir dosya reddediliyor.',
        'CV\'ler, belgeler ve dosya ekleri artık tarayıcıda açılmak yerine indiriliyor; Türkçe karakterli dosya adları da doğru geliyor.',
      ],
      de: [
        'Hochgeladene Dateien werden jetzt anhand ihres tatsächlichen Inhalts geprüft, nicht nur anhand des vom Browser gemeldeten Typs. Eine Datei, die nur so umbenannt wurde, dass sie wie ein PDF oder Bild aussieht, wird abgelehnt.',
        'Lebensläufe, Dokumente und Dateianhänge werden jetzt heruntergeladen statt im Browser geöffnet, und Dateinamen mit Umlauten kommen korrekt an.',
      ],
    },
  },
  {
    version: '0.32.1-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'Security fix: a webhook could be pointed at the server\'s own internal network. Webhook addresses must now be public https endpoints, checked both when saved and each time one is sent.',
        'A slow or unresponsive webhook receiver or AI service can no longer hold the app up — outgoing requests now time out and are logged instead.',
      ],
      tr: [
        'Güvenlik düzeltmesi: bir webhook, sunucunun kendi iç ağına yönlendirilebiliyordu. Webhook adresleri artık genel erişime açık https uçları olmak zorunda ve hem kaydedilirken hem her gönderimde denetleniyor.',
        'Yavaş veya yanıt vermeyen bir webhook alıcısı ya da yapay zekâ servisi artık uygulamayı bekletemiyor — giden istekler zaman aşımına uğrayıp kayda geçiyor.',
      ],
      de: [
        'Sicherheitskorrektur: Ein Webhook konnte auf das interne Netz des Servers gerichtet werden. Webhook-Adressen müssen jetzt öffentliche https-Endpunkte sein und werden beim Speichern sowie bei jedem Versand geprüft.',
        'Ein langsamer oder nicht antwortender Webhook-Empfänger bzw. KI-Dienst kann die Anwendung nicht mehr aufhalten — ausgehende Anfragen laufen jetzt in ein Timeout und werden protokolliert.',
      ],
    },
  },
  {
    version: '0.32.0-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'When an administrator starts a password reset for your account, you are now notified, and the reset link is only ever sent to your own email address — it is no longer shown on the administrator\'s screen. Administrators also can no longer reset another administrator\'s password.',
        'The admin activity log now records where an action came from (IP address, with the browser shown on hover) and covers far more privileged actions: API keys, webhooks, invitations, activating or deactivating a user, organisation and source changes, and mentorship decisions.',
      ],
      tr: [
        'Bir yönetici hesabınız için parola sıfırlama başlattığında artık bilgilendiriliyorsunuz ve sıfırlama bağlantısı yalnızca kendi e-posta adresinize gidiyor — yöneticinin ekranında hiç görünmüyor. Yöneticiler ayrıca başka bir yöneticinin parolasını sıfırlayamıyor.',
        'Yönetici aktivite kaydı artık bir işlemin nereden yapıldığını da tutuyor (IP adresi, tarayıcı bilgisi üzerine gelince görünüyor) ve çok daha fazla ayrıcalıklı işlemi kapsıyor: API anahtarları, webhook\'lar, davetler, kullanıcı aktifleştirme/pasifleştirme, kurum ve kaynak değişiklikleri, mentorluk kararları.',
      ],
      de: [
        'Wenn eine Administratorin oder ein Administrator ein Zurücksetzen Ihres Passworts anstößt, werden Sie jetzt benachrichtigt, und der Link geht ausschließlich an Ihre eigene E-Mail-Adresse — er erscheint nicht mehr auf dem Bildschirm der Administration. Außerdem kann das Passwort anderer Administratoren nicht mehr zurückgesetzt werden.',
        'Das Admin-Aktivitätsprotokoll hält jetzt fest, woher eine Aktion kam (IP-Adresse, Browser beim Überfahren mit der Maus), und deckt deutlich mehr privilegierte Aktionen ab: API-Schlüssel, Webhooks, Einladungen, Aktivieren und Deaktivieren von Nutzern, Organisations- und Quellenänderungen sowie Mentoring-Entscheidungen.',
      ],
    },
  },
  {
    version: '0.31.4-beta',
    date: '2026-07-31',
    highlights: {
      en: ['Internal: rate-limit breaches are now recorded in the admin activity log.'],
      tr: ['Dahili: hız sınırı aşımları artık yönetici aktivite kaydına yazılıyor.'],
      de: ['Intern: Überschreitungen der Ratenbegrenzung werden jetzt im Admin-Aktivitätsprotokoll erfasst.'],
    },
  },
  {
    version: '0.31.3-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'Two-factor authentication is meaningfully stronger: wrong authenticator codes are now limited to five attempts per 15 minutes, and each code works only once. Previously, someone who already had your password could try codes as fast as they liked. Codes from an authenticator app with a slightly off clock still work as before.',
      ],
      tr: [
        'İki adımlı doğrulama belirgin şekilde güçlendi: yanlış doğrulama kodları artık 15 dakikada beş denemeyle sınırlı ve her kod yalnızca bir kez çalışıyor. Önceden, parolanızı ele geçirmiş biri kodları istediği hızda deneyebiliyordu. Saati biraz şaşmış bir uygulamadan gelen kodlar eskisi gibi kabul edilmeye devam ediyor.',
      ],
      de: [
        'Die Zwei-Faktor-Anmeldung ist deutlich stärker: Falsche Codes sind jetzt auf fünf Versuche pro 15 Minuten begrenzt, und jeder Code funktioniert nur einmal. Bisher konnte jemand mit Ihrem Passwort Codes beliebig schnell durchprobieren. Codes aus einer App mit leicht abweichender Uhr werden weiterhin akzeptiert.',
      ],
    },
  },
  {
    version: '0.31.2-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'Changing or resetting your password now signs you out everywhere, including the device you changed it on. If someone else was signed in as you, they are out as soon as you change it — previously their session stayed alive for up to 12 hours. You will be asked to sign in again straight after.',
        'Any password-reset link still sitting in your inbox stops working once you change your password.',
        'Sign-in and other password forms no longer risk putting your password into the page address if you submit before the page has finished loading.',
      ],
      tr: [
        'Parolanızı değiştirmek veya sıfırlamak artık sizi her yerden çıkış yaptırıyor — değişikliği yaptığınız cihaz dâhil. Başka biri sizin adınıza giriş yapmışsa, siz parolayı değiştirir değiştirmez düşüyor; önceden oturumu 12 saate kadar açık kalıyordu. Hemen ardından tekrar giriş yapmanız istenecek.',
        'Posta kutunuzda duran parola sıfırlama bağlantıları, parolanızı değiştirdiğiniz anda geçersiz oluyor.',
        'Giriş ve diğer parola formları, sayfa tam yüklenmeden gönderildiğinde parolanızı sayfa adresine yazma riskini artık taşımıyor.',
      ],
      de: [
        'Das Ändern oder Zurücksetzen des Passworts meldet Sie jetzt überall ab — auch auf dem Gerät, auf dem Sie es geändert haben. War jemand anderes als Sie angemeldet, ist diese Sitzung sofort beendet; bisher blieb sie bis zu 12 Stunden gültig. Direkt danach werden Sie zur erneuten Anmeldung gebeten.',
        'Noch im Postfach liegende Links zum Zurücksetzen des Passworts funktionieren nicht mehr, sobald Sie Ihr Passwort ändern.',
        'Anmelde- und andere Passwortformulare können Ihr Passwort nicht mehr in die Seitenadresse schreiben, wenn Sie absenden, bevor die Seite fertig geladen ist.',
      ],
    },
  },
  {
    version: '0.31.1-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'Security fix: the limits that cap how often password-reset, registration and application forms can be submitted could be sidestepped by faking a network header. They now count real visitors again.',
      ],
      tr: [
        'Güvenlik düzeltmesi: parola sıfırlama, kayıt ve başvuru formlarının ne sıklıkta gönderilebileceğini sınırlayan kurallar, sahte bir ağ başlığıyla aşılabiliyordu. Artık gerçek ziyaretçileri sayıyorlar.',
      ],
      de: [
        'Sicherheitskorrektur: Die Limits dafür, wie oft Passwort-Zurücksetzung, Registrierung und Bewerbungsformulare abgeschickt werden können, ließen sich mit einem gefälschten Netzwerk-Header umgehen. Sie zählen jetzt wieder echte Besucher.',
      ],
    },
  },
  {
    version: '0.31.0-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'A mentor\'s access to a former mentee\'s CV and documents now ends six months after the mentorship is marked complete, instead of lasting indefinitely. Six months rather than immediately, so you can still write a reference or answer a follow-up. You always have access to your own CV, and admins are unaffected.',
        'The admin user list now loads one page at a time, with search and role filters handled by the server. Faster on large lists, and a single request no longer returns everyone\'s contact details.',
      ],
      tr: [
        'Bir mentorun eski mentisinin CV ve belgelerine erişimi artık süresiz değil: mentorluk tamamlandı olarak işaretlendikten altı ay sonra sona eriyor. Hemen değil altı ay, çünkü referans yazmak veya sonraki bir soruyu yanıtlamak hâlâ mümkün olmalı. Kendi CV\'nize erişiminiz her zaman açık; yöneticiler etkilenmiyor.',
        'Yönetici kullanıcı listesi artık sayfa sayfa yükleniyor; arama ve rol filtresi sunucuda çalışıyor. Uzun listelerde daha hızlı ve tek bir istek artık herkesin iletişim bilgisini döndürmüyor.',
      ],
      de: [
        'Der Zugriff eines Mentors auf Lebenslauf und Dokumente eines ehemaligen Mentees endet jetzt sechs Monate nach Abschluss des Mentorings statt unbegrenzt zu gelten. Sechs Monate statt sofort, damit ein Zeugnis oder eine Rückfrage weiterhin möglich bleibt. Auf den eigenen Lebenslauf haben Sie immer Zugriff, Admins sind nicht betroffen.',
        'Die Admin-Benutzerliste lädt jetzt seitenweise, Suche und Rollenfilter laufen auf dem Server. Schneller bei langen Listen — und eine einzelne Anfrage liefert nicht mehr die Kontaktdaten aller Nutzer.',
      ],
    },
  },
  {
    version: '0.30.3-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'Security fix: referral-source accounts could see every project, including private ones. They now see the public showcase only, without member names.',
      ],
      tr: [
        'Güvenlik düzeltmesi: yönlendiren kurum hesapları özel olanlar dâhil tüm projeleri görebiliyordu. Artık yalnızca açık vitrini, üye isimleri olmadan görüyorlar.',
      ],
      de: [
        'Sicherheitskorrektur: Vermittlerkonten konnten alle Projekte sehen, auch private. Sie sehen jetzt nur noch die öffentliche Übersicht, ohne Mitgliedsnamen.',
      ],
    },
  },
  {
    version: '0.30.2-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'Security fix: company and referral-source accounts could see mentorship relations and interaction notes that did not belong to them. Company accounts are now limited to their own company, and referral sources to the candidates they referred. Admin, mentor and mentee views are unchanged.',
      ],
      tr: [
        'Güvenlik düzeltmesi: şirket ve yönlendiren kurum hesapları kendilerine ait olmayan mentorluk ilişkilerini ve görüşme notlarını görebiliyordu. Şirket hesapları artık yalnızca kendi şirketiyle, yönlendiren kurumlar da yalnızca kendi yönlendirdikleri adaylarla sınırlı. Yönetici, mentor ve menti görünümleri değişmedi.',
      ],
      de: [
        'Sicherheitskorrektur: Unternehmens- und Vermittlerkonten konnten Mentoring-Beziehungen und Gesprächsnotizen sehen, die ihnen nicht gehörten. Unternehmenskonten sind jetzt auf das eigene Unternehmen beschränkt, Vermittler auf die von ihnen vermittelten Kandidaten. Ansichten für Admin, Mentor und Mentee bleiben unverändert.',
      ],
    },
  },
  {
    version: '0.30.1-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'The recipient counter on the targeted-email page (mentor and admin) now shows how many mentees are selected out of the total, e.g. "Recipients (3/10)", instead of just the selected count.',
      ],
      tr: [
        'Hedefli e-posta sayfasındaki (mentor ve admin) alıcı sayacı artık yalnızca seçilen sayıyı değil, toplam içinden kaçının seçildiğini gösteriyor, ör. "Alıcılar (3/10)".',
      ],
      de: [
        'Der Empfängerzähler auf der gezielten E-Mail-Seite (Mentor und Admin) zeigt jetzt, wie viele Mentees von der Gesamtzahl ausgewählt sind, z. B. „Empfänger (3/10)“, statt nur die ausgewählte Anzahl.',
      ],
    },
  },
  {
    version: '0.30.0-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'Automatic reminders and digests are now actually being sent on schedule. Interaction reminders, stage-deadline reminders, meeting reminders (about an hour before), the weekly mentor digest, the daily activity digest and the hourly unread-message digest were all built but were never running by themselves — they only went out if an admin triggered them by hand.',
        'Your interaction reminder is now a single daily summary listing every mentee waiting for a log entry, instead of one separate email per mentee — and it respects your notification settings, so you can switch it off like any other email.',
        'Turning this on does not send you a backlog: messages and deadlines from before the change are treated as already handled, so you only hear about what happens from now on.',
      ],
      tr: [
        'Otomatik hatırlatmalar ve özetler artık gerçekten zamanında gönderiliyor. Etkileşim hatırlatmaları, aşama son tarih hatırlatmaları, toplantı hatırlatmaları (yaklaşık bir saat önce), haftalık mentor özeti, günlük aktivite özeti ve saatlik okunmamış mesaj özeti — hepsi yazılmıştı ama kendi başına hiç çalışmıyordu; yalnızca bir yönetici elle tetiklerse gidiyordu.',
        'Etkileşim hatırlatmanız artık her menti için ayrı e-posta yerine, kayıt bekleyen tüm mentileri listeleyen tek bir günlük özet — ve bildirim tercihlerinize uyuyor, yani diğer e-postalar gibi kapatabilirsiniz.',
        'Bunun açılması size birikmiş yığını göndermiyor: değişiklikten önceki mesaj ve son tarihler işlenmiş kabul ediliyor, yalnızca bundan sonra olanları duyuyorsunuz.',
      ],
      de: [
        'Automatische Erinnerungen und Zusammenfassungen werden jetzt wirklich planmäßig verschickt. Interaktions-Erinnerungen, Fristerinnerungen, Termin-Erinnerungen (etwa eine Stunde vorher), die wöchentliche Mentor-Zusammenfassung, die tägliche Aktivitätsübersicht und die stündliche Übersicht ungelesener Nachrichten waren alle gebaut, liefen aber nie von selbst — sie gingen nur raus, wenn ein Admin sie manuell auslöste.',
        'Deine Interaktions-Erinnerung ist jetzt eine einzige tägliche Zusammenfassung mit allen Mentees, die auf einen Eintrag warten, statt einer separaten E-Mail pro Mentee — und sie richtet sich nach deinen Benachrichtigungseinstellungen, du kannst sie also wie jede andere E-Mail abschalten.',
        'Das Einschalten schickt dir keinen Rückstand: Nachrichten und Fristen von vor der Änderung gelten als bereits erledigt, du hörst nur von allem, was ab jetzt passiert.',
      ],
    },
  },
  {
    version: '0.29.1-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'When you reply to a notification by email, the quoted copy of the earlier message is now trimmed more reliably — your reply appears in the thread as just what you typed, without your mail app\'s "…wrote:" line above the quote.',
      ],
      tr: [
        'Bir bildirime e-postayla cevap verdiğinizde, önceki mesajın alıntılanan kopyası artık daha güvenilir biçimde kırpılıyor — cevabınız thread\'de yalnızca yazdığınız kadarıyla, e-posta uygulamanızın alıntı üstüne koyduğu "…yazdı:" satırı olmadan görünüyor.',
      ],
      de: [
        'Wenn du per E-Mail auf eine Benachrichtigung antwortest, wird der zitierte Teil der vorherigen Nachricht jetzt zuverlässiger entfernt — deine Antwort erscheint im Thread nur mit dem, was du geschrieben hast, ohne die „…schrieb:“-Zeile deines Mailprogramms über dem Zitat.',
      ],
    },
  },
  {
    version: '0.29.0-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'Replying to a message notification by email now works. Those emails have always invited you to "reply to this email", but nothing was picking the replies up on our side, so they never reached the conversation. Your reply now shows up in the thread within about a minute, marked as sent by email, and the other person is notified as usual. Quoted history from the email is trimmed off automatically.',
        'Reply-by-email works for mentor ↔ mentee conversations. Project group chats do not support it — replying to one of those notifications still will not post to the group, so use the app for those.',
      ],
      tr: [
        'Mesaj bildirimine e-postayla cevap vermek artık çalışıyor. Bu e-postalar hep "bu e-postayı yanıtlayın" diyordu ama bizim tarafta cevapları alan bir şey yoktu, dolayısıyla sohbete hiç ulaşmıyorlardı. Cevabınız artık bir dakika içinde thread\'de görünüyor, e-postayla gönderildiği belirtiliyor ve karşı tarafa her zamanki gibi bildirim gidiyor. E-postadaki alıntılanmış geçmiş otomatik olarak kırpılıyor.',
        'E-postayla cevaplama mentor ↔ menti sohbetleri için geçerli. Proje grup sohbetleri bunu desteklemiyor — o bildirimlere verilen cevaplar gruba düşmüyor, onlar için uygulamayı kullanın.',
      ],
      de: [
        'Auf eine Nachrichten-Benachrichtigung per E-Mail zu antworten funktioniert jetzt. Diese E-Mails haben immer dazu eingeladen, „auf diese E-Mail zu antworten“, aber auf unserer Seite hat niemand die Antworten abgeholt — sie kamen also nie im Gespräch an. Deine Antwort erscheint jetzt innerhalb einer Minute im Thread, als per E-Mail gesendet markiert, und die andere Person wird wie gewohnt benachrichtigt. Zitierter Verlauf aus der E-Mail wird automatisch entfernt.',
        'Antworten per E-Mail gilt für Mentor-↔-Mentee-Gespräche. Projekt-Gruppenchats unterstützen es nicht — eine Antwort auf eine solche Benachrichtigung landet weiterhin nicht in der Gruppe, nutze dafür die App.',
      ],
    },
  },
  {
    version: '0.28.4-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'Laid the groundwork for an upcoming short program-feedback survey — translation work only for now, nothing visible in the app yet.',
      ],
      tr: [
        'Yakında gelecek kısa bir program geri bildirim anketi için altyapı hazırlandı — şimdilik yalnızca çeviri çalışması, uygulamada henüz görünür bir şey yok.',
      ],
      de: [
        'Grundlage für eine bald kommende kurze Programm-Feedback-Umfrage gelegt — vorerst nur Übersetzungsarbeit, in der App noch nicht sichtbar.',
      ],
    },
  },
  {
    version: '0.28.3-beta',
    date: '2026-07-31',
    highlights: {
      en: [
        'A few dates that were quietly following your browser\'s language instead of the app\'s — the full analytics report\'s "generated on" date, the meeting date/time on the RSVP page, and the date on each interaction log entry in your portal — now display in your selected app language.',
      ],
      tr: [
        'Uygulamanın diline değil sessizce tarayıcınızın diline uyan birkaç tarih — tam analiz raporundaki "oluşturulma tarihi", RSVP sayfasındaki toplantı tarihi/saati ve portalınızdaki her etkileşim kaydının tarihi — artık seçtiğiniz uygulama dilinde gösteriliyor.',
      ],
      de: [
        'Ein paar Daten, die still der Sprache deines Browsers statt der App-Sprache folgten — das „erstellt am“-Datum im vollständigen Analysebericht, Termin-Datum/-Uhrzeit auf der RSVP-Seite und das Datum jedes Interaktionseintrags in deinem Portal — werden jetzt in deiner gewählten App-Sprache angezeigt.',
      ],
    },
  },
  {
    version: '0.28.2-beta',
    date: '2026-07-30',
    highlights: {
      en: [
        'A new Notifications page shows your full notification history, not just the last 20 in the bell — filter by read/unread or by type, page through older ones, and see exactly how many you have. Open it from the new "View all" link at the bottom of the bell dropdown.',
        'Your mentee/mentor dashboard now has an Announcements card with the latest updates from admins, and a page to browse the full history — separate from your personal notifications.',
        'Every project now has a shared group chat for its owners, mentors and mentees. Open Messages from the chat icon in the header, then choose the row marked "Project group" next to your project name. The group supports the same attachments, reactions and notification preferences as your other conversations, and membership updates automatically when people join or leave the project.',
        'When an admin assigns you a mentor directly, you now hear about it: both the mentee and the mentor get a notification in the app and an email. Previously this only happened when a mentee had requested a mentor themselves — a direct assignment was silent, so you had to notice it on your own next time you logged in.',
        'Emails your mentor sends to you from their dashboard now follow your notification settings — if you have switched off message emails, they no longer arrive. Your mentor still sees the message in your interaction history either way.',
        'Scheduled emails are more reliable: one address that fails no longer stops the rest of that batch from going out.',
      ],
      tr: [
        'Yeni Bildirimler sayfası, zil menüsündeki son 20 bildirimle sınırlı kalmadan tüm bildirim geçmişinizi gösterir — okundu/okunmadı veya türe göre filtreleyin, eski bildirimlerde sayfalar arasında gezin ve toplam kaç bildiriminiz olduğunu görün. Zil menüsünün altındaki yeni "Tümünü gör" bağlantısından açabilirsiniz.',
        'Menti/mentor panonuzda artık yöneticilerden gelen son güncellemeleri gösteren bir Duyurular kartı var, ayrıca tüm duyuru geçmişini görebileceğiniz — kişisel bildirimlerinizden ayrı — bir sayfa da eklendi.',
        'Artık her projenin owner, mentor ve mentee üyeleri için ortak bir grup sohbeti var. Üst menüdeki sohbet simgesinden Mesajlar’ı açıp proje adının yanında "Proje grubu" yazan satırı seç. Grup; diğer sohbetlerinle aynı dosya eki, tepki ve bildirim tercihlerini destekliyor, katılımcılar da projeye giren veya projeden ayrılan üyelere göre otomatik güncelleniyor.',
        'Bir yönetici size doğrudan mentor atadığında artık haberdar oluyorsunuz: hem menti hem de mentor uygulama içinde bildirim ve e-posta alıyor. Daha önce bu yalnızca menti kendisi mentor talebinde bulunduğunda oluyordu — doğrudan atama sessizdi, bir sonraki girişinizde kendiniz fark etmeniz gerekiyordu.',
        'Mentorunuzun panelinden size gönderdiği e-postalar artık bildirim tercihlerinize uyuyor — mesaj e-postalarını kapattıysanız artık gelmiyor. Mentorunuz mesajı her durumda etkileşim geçmişinizde görmeye devam ediyor.',
        'Zamanlanmış e-postalar daha güvenilir: başarısız olan tek bir adres artık o gruptaki diğer e-postaların gönderilmesini engellemiyor.',
      ],
      de: [
        'Dein Mentee-/Mentor-Dashboard hat jetzt eine Ankündigungen-Karte mit den neuesten Updates der Admins sowie eine Seite für den vollständigen Verlauf — getrennt von deinen persönlichen Benachrichtigungen.',
        'Eine neue Benachrichtigungen-Seite zeigt deinen kompletten Benachrichtigungsverlauf, nicht nur die letzten 20 in der Glocke — filtere nach gelesen/ungelesen oder nach Typ, blättere durch ältere Einträge und sieh genau, wie viele du hast. Öffne sie über den neuen Link "Alle anzeigen" am unteren Rand des Glocken-Menüs.',
        'Jedes Projekt hat jetzt einen gemeinsamen Gruppenchat für Owner, Mentoren und Mentees. Öffne Nachrichten über das Chat-Symbol in der Kopfzeile und wähle die mit „Projektgruppe“ gekennzeichnete Zeile neben deinem Projektnamen. Die Gruppe unterstützt dieselben Anhänge, Reaktionen und Benachrichtigungseinstellungen wie deine anderen Unterhaltungen; die Teilnehmer werden automatisch aktualisiert, wenn jemand dem Projekt beitritt oder es verlässt.',
        'Wenn ein Admin dir direkt einen Mentor zuweist, erfährst du das jetzt: Mentee und Mentor erhalten eine Benachrichtigung in der App und eine E-Mail. Bisher passierte das nur, wenn ein Mentee selbst einen Mentor angefragt hatte — eine direkte Zuweisung blieb stumm und musste beim nächsten Login selbst entdeckt werden.',
        'E-Mails, die dein Mentor dir aus seinem Dashboard schickt, richten sich jetzt nach deinen Benachrichtigungseinstellungen — hast du Nachrichten-E-Mails abgeschaltet, kommen sie nicht mehr an. Dein Mentor sieht die Nachricht in beiden Fällen weiterhin in deinem Interaktionsverlauf.',
        'Geplante E-Mails sind zuverlässiger: Eine fehlerhafte Adresse verhindert nicht mehr, dass der Rest des Stapels versendet wird.',
      ],
    },
  },
  {
    version: '0.28.1-beta',
    date: '2026-07-29',
    highlights: {
      en: [
        'Reliability fix in the data-isolation layer for multi-organization setups: a rare code path could run a database query without the organization filter attached. It is now guaranteed to be applied in every case. Single-organization installations are unaffected.',
      ],
      tr: [
        'Çoklu-kuruluş kurulumları için veri izolasyonu katmanında güvenilirlik düzeltmesi: nadir bir kod yolu, veritabanı sorgusunu kuruluş filtresi eklenmeden çalıştırabiliyordu. Artık filtrenin her durumda uygulanması garanti altında. Tek kuruluşlu kurulumlar bu durumdan etkilenmiyordu.',
      ],
      de: [
        'Zuverlässigkeitskorrektur in der Datenisolationsschicht für Installationen mit mehreren Organisationen: Ein seltener Codepfad konnte eine Datenbankabfrage ohne den Organisationsfilter ausführen. Der Filter wird jetzt garantiert in jedem Fall angewendet. Installationen mit nur einer Organisation waren nicht betroffen.',
      ],
    },
  },
  {
    version: '0.28.0-beta',
    date: '2026-07-28',
    highlights: {
      en: [
        'The Announcements box now has the live character counter too, and stops you at the 20 000-character limit as you type — instead of accepting a long message and then failing with an untranslated "Validation failed" after you pressed Broadcast.',
        'Long text now saves everywhere it said it would. Meeting notes, company descriptions and shortlist notes were being cut off by a database limit far smaller than the counter promised, so a normal paragraph could fail to save — in the case of a bulk mentor email, only after the email had already gone out. Every one of those fields now genuinely holds what the counter shows.',
        'Fixed a company description box that could not be typed into at all, and a counter that sat on top of the resize handle so a textarea could not be dragged bigger.',
      ],
      tr: [
        'Duyurular kutusunda da artık canlı karakter sayacı var ve yazarken 20 000 karakter sınırında sizi durduruyor — uzun bir mesajı kabul edip, siz Yayınla\'ya bastıktan sonra çevrilmemiş bir "Validation failed" hatasıyla başarısız olmak yerine.',
        'Uzun metinler artık söz verilen her yerde kaydediliyor. Görüşme notları, şirket açıklamaları ve kısa liste notları, sayacın belirttiğinden çok daha küçük bir veritabanı sınırına takılıyordu; yani normal uzunlukta bir paragraf kaydedilemiyordu — toplu mentor e-postasında ise ancak e-posta gönderildikten sonra. Bu alanların hepsi artık sayacın gösterdiği kadarını gerçekten tutuyor.',
        'Hiç yazı yazılamayan şirket açıklaması kutusu düzeltildi; ayrıca yeniden boyutlandırma tutamacının üstüne binen ve metin alanının büyütülmesini engelleyen sayaç sorunu giderildi.',
      ],
      de: [
        'Auch das Ankündigungsfeld hat jetzt den Live-Zeichenzähler und stoppt dich beim Tippen an der Grenze von 20 000 Zeichen — statt eine lange Nachricht anzunehmen und nach dem Senden mit einem unübersetzten „Validation failed" zu scheitern.',
        'Lange Texte werden jetzt überall dort gespeichert, wo es versprochen war. Gesprächsnotizen, Firmenbeschreibungen und Shortlist-Notizen liefen gegen ein Datenbanklimit, das weit kleiner war als der Zähler anzeigte — ein normaler Absatz konnte also nicht gespeichert werden, bei einer Mentor-Sammelmail sogar erst nachdem die E-Mail schon raus war. Alle diese Felder halten jetzt wirklich so viel, wie der Zähler anzeigt.',
        'Ein Firmenbeschreibungsfeld, in das man überhaupt nicht schreiben konnte, ist behoben — ebenso ein Zähler, der auf dem Anfasser zum Vergrößern lag, sodass sich das Textfeld nicht ziehen ließ.',
      ],
    },
  },
  {
    version: '0.27.0-beta',
    date: '2026-07-28',
    highlights: {
      en: [
        'You can now message anyone you share a project with — not just your mentor. Open Messages, pick "New chat", and choose a project team-mate to start a one-to-one conversation. It behaves exactly like your mentor chat: attachments, pasted images, reactions, editing and read receipts all work the same, and new conversations show up in the same inbox list.',
        'If you stop sharing a project with someone, your conversation with them stays readable — you keep the whole history, you just cannot send new messages in it.',
      ],
      tr: [
        'Artık yalnızca mentorunla değil, aynı projede olduğun herkesle mesajlaşabilirsin. Mesajlar\'ı açıp "Yeni sohbet"e dokun ve bir proje arkadaşını seçerek birebir sohbet başlat. Mentor sohbetinle tamamen aynı şekilde çalışıyor: dosya ekleri, yapıştırılan görseller, tepkiler, düzenleme ve okundu bilgisi aynı; yeni sohbetler de aynı gelen kutusu listesinde görünüyor.',
        'Biriyle aynı projede olmayı bıraktığınızda o sohbet okunabilir kalıyor — tüm geçmişi görmeye devam ediyorsun, yalnızca yeni mesaj gönderemiyorsun.',
      ],
      de: [
        'Du kannst jetzt allen schreiben, mit denen du ein Projekt teilst — nicht mehr nur deinem Mentor. Öffne Nachrichten, tippe auf "Neuer Chat" und wähle eine Person aus deinem Projektteam für eine Einzelunterhaltung. Sie verhält sich genau wie der Mentor-Chat: Anhänge, eingefügte Bilder, Reaktionen, Bearbeiten und Lesebestätigungen funktionieren identisch, und neue Unterhaltungen erscheinen in derselben Übersicht.',
        'Teilst du mit jemandem kein Projekt mehr, bleibt die Unterhaltung lesbar — der gesamte Verlauf bleibt erhalten, du kannst nur keine neuen Nachrichten mehr senden.',
      ],
    },
  },
  {
    version: '0.26.1-beta',
    date: '2026-07-28',
    highlights: {
      en: [
        'Meeting reminders now arrive about an hour before the meeting instead of a day ahead — and they go to everyone involved, mentor and mentee alike, not just the mentee. You always get the reminder in the app; the email version follows your notification settings, so you can switch it off and still see the reminder on your bell. Each meeting is only ever reminded once.',
      ],
      tr: [
        'Toplantı hatırlatmaları artık bir gün önce değil, toplantıdan yaklaşık bir saat önce geliyor — ve yalnızca mentiye değil, mentor ve menti dahil tüm katılımcılara gidiyor. Hatırlatmayı uygulama içinde her zaman alıyorsunuz; e-posta olarak gönderilmesi bildirim tercihlerinize bağlı, yani e-postayı kapatsanız bile hatırlatma bildirim zilinizde görünmeye devam ediyor. Her toplantı için hatırlatma yalnızca bir kez gönderiliyor.',
      ],
      de: [
        'Terminerinnerungen kommen jetzt etwa eine Stunde vor dem Termin statt einen Tag vorher — und sie gehen an alle Beteiligten, Mentor und Mentee, nicht nur an den Mentee. In der App erhältst du die Erinnerung immer; ob sie zusätzlich per E-Mail kommt, richtet sich nach deinen Benachrichtigungseinstellungen — schaltest du die E-Mail ab, erscheint die Erinnerung weiterhin in deiner Glocke. Pro Termin wird nur ein einziges Mal erinnert.',
      ],
    },
  },
  {
    version: '0.26.0-beta',
    date: '2026-07-28',
    highlights: {
      en: [
        'Important events now reach you by email, not just in the app: a mentorship request being approved or rejected, a new request landing in the admin queue, an enquiry from your public profile (you can reply straight to the sender), and meeting requests being sent, accepted or declined. Everything respects your notification settings, and there is a new "Mentorship updates" switch to turn just those off.',
        'Goals can be sorted newest-first or oldest-first, and completed goals move out of your active list into a new Archive tab — where they keep their completion date and can be reopened at any time.',
        'Support: admins can now attach files and images to their replies — a message on its own, files on their own, or both together. Images can be previewed and any file removed before sending, using the same file types and size limits as the rest of the support conversation.',
      ],
      tr: [
        'Önemli olaylar artık yalnızca uygulama içinde değil, e-posta ile de size ulaşıyor: mentorluk talebinizin onaylanması veya reddedilmesi, yönetici kuyruğuna yeni bir talep düşmesi, herkese açık profilinizden gelen bir başvuru (doğrudan gönderene yanıt verebilirsiniz) ve toplantı taleplerinin gönderilmesi, kabul edilmesi veya reddedilmesi. Tümü bildirim tercihlerinize saygı gösteriyor; sadece bunları kapatmak için yeni bir "Mentorluk güncellemeleri" anahtarı var.',
        'Hedefler yeniden eskiye veya eskiden yeniye sıralanabiliyor ve tamamlanan hedefler aktif listenizden çıkıp yeni Arşiv sekmesine taşınıyor — tamamlanma tarihlerini koruyorlar ve istediğiniz zaman yeniden açılabiliyorlar.',
        'Destek: yöneticiler artık yanıtlarına dosya ve görsel ekleyebiliyor — yalnızca mesaj, yalnızca dosya veya ikisi birlikte. Görseller gönderilmeden önce önizlenebiliyor ve eklenen dosyalar kaldırılabiliyor; destek konuşmasının geri kalanıyla aynı dosya türleri ve boyut limitleri geçerli.',
      ],
      de: [
        'Wichtige Ereignisse erreichen dich jetzt auch per E-Mail und nicht nur in der App: die Annahme oder Ablehnung einer Mentoring-Anfrage, eine neue Anfrage in der Admin-Warteschlange, eine Anfrage über dein öffentliches Profil (du kannst direkt dem Absender antworten) sowie gesendete, angenommene oder abgelehnte Terminanfragen. Alles berücksichtigt deine Benachrichtigungseinstellungen, und mit dem neuen Schalter "Mentoring-Updates" schaltest du genau diese ab.',
        'Ziele lassen sich nach neuesten oder ältesten sortieren, und abgeschlossene Ziele wandern aus der aktiven Liste in einen neuen Archiv-Tab — dort behalten sie ihr Abschlussdatum und können jederzeit wieder geöffnet werden.',
        'Support: Admins können ihren Antworten jetzt Dateien und Bilder anhängen — nur eine Nachricht, nur Dateien oder beides. Bilder lassen sich vor dem Senden in der Vorschau ansehen und angehängte Dateien entfernen; es gelten dieselben Dateitypen und Größenlimits wie im restlichen Support-Verlauf.',
      ],
    },
  },
  {
    version: '0.25.15-beta',
    date: '2026-07-28',
    highlights: {
      en: [
        'The projects list no longer flashes "(0)" while it is still loading — the project count now appears only once the data has arrived, so an empty list is never mistaken for a slow one.',
      ],
      tr: [
        'Projeler listesi yüklenirken artık "(0)" göstermiyor — proje sayısı yalnızca veriler geldikten sonra çıkıyor, böylece boş liste ile yavaş yüklenen liste karışmıyor.',
      ],
      de: [
        'Die Projektliste zeigt beim Laden nicht mehr "(0)" — die Projektanzahl erscheint erst, wenn die Daten geladen sind, sodass eine leere Liste nicht mit einer langsam ladenden verwechselt wird.',
      ],
    },
  },
  {
    version: '0.25.14-beta',
    date: '2026-07-24',
    highlights: {
      en: [
        'The Candidates list now hides deactivated candidates by default and keeps them in a separate Archive view — switch between Active and Archived with one click. Exports follow whichever view you\'re in, and you can bulk-reactivate archived candidates to move them back.',
      ],
      tr: [
        'Adaylar listesi artık devre dışı bırakılmış adayları varsayılan olarak gizliyor ve onları ayrı bir Arşiv görünümünde tutuyor — Aktif ve Arşiv arasında tek tıkla geçin. Dışa aktarma bulunduğunuz görünümü izler ve arşivdeki adayları toplu olarak yeniden etkinleştirip geri taşıyabilirsiniz.',
      ],
      de: [
        'Die Kandidatenliste blendet deaktivierte Kandidaten jetzt standardmäßig aus und hält sie in einer separaten Archiv-Ansicht — mit einem Klick zwischen Aktiv und Archiviert wechseln. Exporte folgen der aktuellen Ansicht, und du kannst archivierte Kandidaten per Sammelaktion wieder aktivieren.',
      ],
    },
  },
  {
    version: '0.25.13-beta',
    date: '2026-07-27',
    highlights: {
      en: [
        'Admins can now attach images or PDF files when replying to a support ticket — with the same preview and pre-send removal as the requester side. Replies can include text, an attachment, or both.',
      ],
      tr: [
        'Adminler artık bir destek talebine yanıt verirken görsel veya PDF dosyası ekleyebiliyor — talep sahibi tarafındaki gibi aynı önizleme ve gönderim öncesi kaldırma özellikleriyle. Yanıtlar metin, ek veya ikisini birden içerebilir.',
      ],
      de: [
        'Admins können jetzt beim Antworten auf ein Support-Ticket Bilder oder PDF-Dateien anhängen — mit derselben Vorschau und Entfernung vor dem Senden wie auf der Anfragerseite. Antworten können Text, einen Anhang oder beides enthalten.',
      ],
    },
  },
  {
    version: '0.25.12-beta',
    date: '2026-07-27',
    highlights: {
      en: [
        'Fixed the Projects page briefly showing "(0)" next to "All projects" while the list was still loading. Goals are easier to manage: sort them newest or oldest first, edit active goals inline, and open the collapsible archive whenever you need to view, reopen or delete completed goals.',
      ],
      tr: [
        'Projeler sayfasında liste henüz yüklenirken "Tüm projeler" yazısının yanında kısaca "(0)" görünmesi giderildi. Hedefleri yönetmek artık daha kolay: hedefleri yeniden eskiye veya eskiden yeniye sıralayın, aktif hedefleri yerinde düzenleyin ve tamamlanan hedefleri görüntülemek, yeniden açmak ya da silmek için daraltılabilir arşivi açın.',
      ],
      de: [
        'Behoben: Auf der Projekte-Seite zeigte "Alle Projekte" beim Laden kurzzeitig "(0)" an. Ziele lassen sich jetzt einfacher verwalten: Sortiere sie nach den neuesten oder ältesten zuerst, bearbeite aktive Ziele direkt und öffne das einklappbare Archiv, um abgeschlossene Ziele anzusehen, wieder zu öffnen oder zu löschen.',
      ],
    },
  },
  {
    version: '0.25.11-beta',
    date: '2026-07-24',
    highlights: {
      en: [
        'All text areas now show a live character counter — you can see how many characters you\'ve used and how many remain (e.g. "42 / 2 000"). The counter turns amber when you approach the limit and red when you\'re at it, so you never hit an unexpected cutoff.',
      ],
      tr: [
        'Tüm metin alanları artık canlı karakter sayacı gösteriyor — kaç karakter kullandığınızı ve kaç karakter kaldığını görebilirsiniz (ör. "42 / 2 000"). Sayaç limite yaklaştığınızda kehribar rengine, limite ulaştığınızda kırmızıya döner; böylece beklenmedik bir kesilmeyle karşılaşmazsınız.',
      ],
      de: [
        'Alle Textfelder zeigen jetzt einen Live-Zeichenzähler — du siehst, wie viele Zeichen du verwendet hast und wie viele noch übrig sind (z. B. „42 / 2 000"). Der Zähler wechselt zu Amber, wenn du dich dem Limit näherst, und zu Rot, wenn du es erreichst — damit du nie an einem unerwarteten Abschnitt scheiterst.',
      ],
    },
  },
  {
    version: '0.25.10-beta',
    date: '2026-07-23',
    highlights: {
      en: ['Recurring meetings now support automatic forward scheduling from a reusable series rule. Participants are derived from project members, duplicate future instances are prevented, and cancelling a series stops new auto-created meetings.'],
      tr: ['Tekrarlayan toplantılar artık seri kuralından ileri tarihli otomatik planlama yapıyor. Katılımcılar proje üyelerinden türetiliyor, yinelenen gelecek kayıtlar engelleniyor ve seri iptal edilince yeni otomatik toplantı üretimi duruyor.'],
      de: ['Wiederkehrende Meetings unterstützen jetzt die automatische Vorausplanung aus einer Serienregel. Teilnehmende werden aus Projektmitgliedern abgeleitet, doppelte zukünftige Einträge werden verhindert, und das Abbrechen einer Serie stoppt neue automatische Meetings.'],
    },
  },
  {
    version: '0.25.9-beta',
    date: '2026-07-23',
    highlights: {
      en: [
        'Foundation for recurring meetings: the database now tracks meeting series (recurrence rules). This is an internal schema update — the recurring-meeting scheduling UI is coming soon.',
        'Support conversations now match the rest of the messaging experience, and you can send text, attachments, or both.',
      ],
      tr: [
        'Tekrarlayan toplantılar için temel: veritabanı artık toplantı serilerini (tekrarlama kurallarını) takip ediyor. Bu dahili bir şema güncellemesidir — tekrarlayan toplantı planlama arayüzü çok yakında geliyor.',
        'Destek konuşmaları artık uygulamadaki diğer mesajlaşma deneyimiyle eşleşiyor; metin, ek veya ikisini birlikte gönderebilirsiniz.',
      ],
      de: [
        'Grundlage für wiederkehrende Meetings: Die Datenbank speichert jetzt Meeting-Serien (Wiederholungsregeln). Dies ist ein internes Schema-Update — die Benutzeroberfläche für wiederkehrende Meetings folgt bald.',
        'Support-Unterhaltungen entsprechen jetzt dem übrigen Nachrichtenerlebnis; du kannst Text, Anhänge oder beides senden.',
      ],
    },
  },
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
      en: [
        'You can now attach PNG or JPEG images and PDF documents to support messages, preview images before sending, and remove files you no longer want to include.',
        'Fixed: when you schedule a meeting for several mentees at once, everyone now gets the same meeting link and joins one shared call — instead of each person getting a separate room.',
      ],
      tr: [
        'Artık destek mesajlarına PNG veya JPEG görselleri ve PDF belgeleri ekleyebilir, görselleri göndermeden önce önizleyebilir ve istemediğiniz dosyaları kaldırabilirsiniz.',
        'Düzeltildi: birden çok menteeye aynı anda toplantı planladığınızda artık herkese aynı toplantı linki gidiyor ve tek bir ortak görüşmede buluşuluyor — önceki gibi herkese ayrı oda oluşturulmuyor.',
      ],
      de: [
        'Du kannst jetzt PNG- oder JPEG-Bilder und PDF-Dokumente an Support-Nachrichten anhängen, Bilder vor dem Senden ansehen und nicht benötigte Dateien entfernen.',
        'Behoben: Wenn du ein Meeting für mehrere Mentees gleichzeitig planst, erhalten jetzt alle denselben Meeting-Link und treffen sich in einem gemeinsamen Call — statt dass jede Person einen eigenen Raum bekommt.',
      ],
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
