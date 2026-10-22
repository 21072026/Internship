// The starter mentoring agreement (#1790) — what a fresh organisation sees
// instead of an empty editor. It is a TEMPLATE, and says so in its first line in
// every language: an agreement is legal-adjacent, and each programme must adapt
// it (cadence, duration, who the concern contact is) before relying on it. The
// English text is the authoritative one; TR and DE translate it.
//
// Installed as version "1" of key "default" the first time an organisation's
// agreement is read (ensureDefaultAgreement in src/lib/mentoringAgreement.ts),
// so what a pair accepts is always a stored row, never this constant — editing
// this file later changes nothing anybody has already accepted.

export const DEFAULT_AGREEMENT_VERSION = '1';
export const DEFAULT_AGREEMENT_AUTHORITATIVE = 'en' as const;

export const DEFAULT_AGREEMENT_BODY: Record<'en' | 'tr' | 'de', string> = {
  en: `**Template — adapt this agreement to your programme before relying on it.**

## Mentoring agreement

**Purpose.** The mentor supports the mentee's professional development and their path into work. The mentee sets their own goals; the mentor helps them get there.

**Cadence.** We aim to meet regularly — as a guide, every two weeks — and to say in advance when a meeting cannot happen.

**Duration.** The mentorship runs for the length of the programme unless either of us ends it earlier.

**Confidentiality.** What we discuss stays between us. Exceptions are a risk to someone's safety and what the law requires.

**Ending it.** Either of us may end the mentorship at any time, ideally with a short conversation. The programme team can help with a different match.

**Raising a concern.** If something does not feel right, either of us can contact the programme team at any time, without having to talk to the other person first.`,
  tr: `**Şablon — bu sözleşmeyi kullanmadan önce kendi programınıza uyarlayın.**

## Mentorluk sözleşmesi

**Amaç.** Mentor, mentee'nin mesleki gelişimini ve iş hayatına geçişini destekler. Hedefleri mentee belirler; mentor oraya ulaşmasına yardım eder.

**Görüşme sıklığı.** Düzenli görüşmeyi hedefleriz — yol gösterici olarak iki haftada bir — ve bir görüşme yapılamayacaksa önceden haber veririz.

**Süre.** Mentorluk, birimiz daha önce bitirmedikçe program süresince devam eder.

**Gizlilik.** Konuştuklarımız aramızda kalır. İstisnalar, birinin güvenliğine yönelik bir risk ve yasanın gerektirdikleridir.

**Sonlandırma.** İkimiz de mentorluğu istediğimiz zaman, tercihen kısa bir konuşmayla sonlandırabiliriz. Program ekibi farklı bir eşleşme için yardımcı olabilir.

**Endişe bildirme.** Bir şey doğru gelmezse ikimiz de program ekibine her zaman, önce diğer kişiyle konuşmak zorunda kalmadan ulaşabiliriz.`,
  de: `**Vorlage — passe diese Vereinbarung an euer Programm an, bevor ihr euch darauf stützt.**

## Mentoring-Vereinbarung

**Zweck.** Die Mentorin oder der Mentor unterstützt die berufliche Entwicklung der Mentee und ihren Weg in den Beruf. Die Ziele setzt die Mentee selbst; die Mentorin oder der Mentor hilft, sie zu erreichen.

**Rhythmus.** Wir treffen uns regelmäßig — als Richtwert alle zwei Wochen — und sagen rechtzeitig Bescheid, wenn ein Termin ausfällt.

**Dauer.** Das Mentoring läuft über die Dauer des Programms, sofern es niemand von uns früher beendet.

**Vertraulichkeit.** Was wir besprechen, bleibt unter uns. Ausnahmen sind eine Gefahr für die Sicherheit einer Person und gesetzliche Pflichten.

**Beenden.** Jede Seite kann das Mentoring jederzeit beenden, am besten mit einem kurzen Gespräch. Das Programmteam hilft bei einer anderen Zuordnung.

**Bedenken melden.** Wenn sich etwas nicht richtig anfühlt, können wir uns jederzeit an das Programmteam wenden, ohne vorher mit der anderen Person sprechen zu müssen.`,
};
