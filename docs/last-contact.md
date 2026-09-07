# "Son temas" ne demek? (#2275)

> Mentor panosundaki *Yakın zamanda temas yok* rozetinin, hatırlatma
> e-postalarının ve mentee kartlarındaki "Son etkileşimden bu yana N gün"
> satırının tek kaynağı.

## Problem

Mentor panosu, mentee ile bütün hafta uygulama içinde yazışmış bir mentora hâlâ
*Yakın zamanda temas yok* diyordu. Sebep tek satırdı: "temas" yalnızca
`InteractionLog` tablosundan okunuyordu — yani mentorun ayrıca doldurmayı
hatırladığı formdan. Etkileşim artık büyük ölçüde uygulamanın kendi
mesajlaşmasında geçtiği için "Dikkat gerektiriyor" listesi on bir satıra çıkıp
hiçbir şey ifade etmez hâle geldi; bir mentorun listeyi ciddiye almayı bırakması
da tam olarak bu şekilde oluyor.

## Kural

Tek kaynak `src/lib/lastContactRule.ts` (kural, bağımlılıksız ve birim testli),
sorguları `src/lib/lastContact.ts`. Bir ilişkinin **son teması**, aşağıdakilerin
**en yenisidir**:

| Sinyal | Sayılır mı? | Neden |
|---|---|---|
| `InteractionLog` kaydı | ✅ | Zaten kuralın eski hâli; elle girilen ve otomatik (toplantı) kayıtlar dâhil |
| Mentorluk başlığındaki **birebir (DIRECT) mesaj** — her iki yönde | ✅ | Mentor yazmış ya da mentee cevaplamış; ikisi de tam olarak bu iki kişi arasında geçen temastır |
| **Grup mesajı** — mentee'nin **kendi** yazdığı | ✅ | Bir proje kanalına yazan kişi, kayıt olup kaybolmuş biri değildir. Yaşam belirtisi kişiye aittir, eşleşmeye değil: mentee'nin bir grup mesajı, içinde bulunduğu **bütün** mentorluklara işlenir |
| **Grup mesajı** — başkasının yazdığı | ❌ | Grup sohbeti bir yayındır. Dokuz mentee'nin bulunduğu kanala mentorun düştüğü tek satır, dokuz mentee ile temas değildir; öyle sayılsa listeyi hepsi için birden susturur — bu dokümanın düzeltmeye çalıştığı hatanın tersi |
| Mesaj okuma, emoji tepkisi, giriş yapma | ❌ | Bunlar "kişi buradaydı" der, "konuştular" demez. Mevcudiyet `lib/activityReport.ts`'in işi |

Eşitlik hâlinde damga aynı olduğu için yalnızca raporlanan `source` değişir
(`interaction` > `direct_message` > `group_message`).

## Kuralı kullanan yerler

Hepsi aynı fonksiyondan okur; biri değişirse hepsi değişir:

- `src/lib/mentorAttention.ts` — *Yakın zamanda temas yok* rozeti ve
  "Son etkileşimden bu yana N gün" (eşik: `Setting.reminderDays`, varsayılan 14)
- `checkMentorInteractionReminders()` — günlük durgunluk hatırlatması (zil
  bildirimi + gruplanmış mentor e-postası)
- `sendWeeklyMentorDigests()` — haftalık özetteki "durgun mentee" sayısı
- `/mentor` mentee kartları
- `/api/users/[id]` → `menteeRelations[].lastContactAt` — `/admin/candidates/[id]`
  sayfasındaki "Sıradaki aksiyon" önerisi (`lib/matching.ts`)
- `src/lib/dormantFirstContact.ts` — mentee'nin kendi grup mesajı da bir yaşam
  belirtisi sayılır, yani damgayı ve "hâlâ ilgileniyor musun?" sayaçlarını
  sıfırlar (bkz. [dormant-first-contacts.md](dormant-first-contacts.md))

## Bilinçli olarak yapılmayanlar

- **Etkileşim sayaçları değişmedi.** `/mentor` panosundaki "Toplam Etkileşim",
  mentee listesindeki rozet ve `/mentor/interactions` sayfası hâlâ
  `InteractionLog` satırlarını sayar. Orada gösterilen şey bir *kayıt defteri*;
  bir mesajı oraya satır olarak eklemek defterin ne olduğunu değiştirirdi.
  Değişen şey **tazelik** — yani "temas var mı?" sorusu.
- **Mentorun grup mesajı hiçbir yerde temas sayılmıyor** — ne bu kuralda, ne de
  pasiflik kuralındaki "ilk temas" (outreach) tarafında.
