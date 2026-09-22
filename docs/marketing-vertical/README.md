# Marketing dikeyi — devralınan backlog

Bu klasör, kapatılan **`21072026/Marketing`** repo'sundan (SaleVali Marketing CRM)
devralınan ürün backlog'unu tutar: 9 epic, 22 story, 89 görev; her görevin
Almanca/Türkçe özeti, önceliği, eforu, "Done when" ölçütleri ve hazır bir
başlangıç prompt'u var.

Repo silinmeden önce buraya taşındı. Kaybolan tek şey GitHub issue'larının
kendisi — dosyalardaki `21072026/Marketing/issues/...` bağlantıları artık ölü.

## ⚠️ Bu dosyalar dikey kararından ÖNCE yazıldı

Backlog, Marketing CRM'in **ayrı bir ürün ve ayrı bir repo** olarak devam
edeceği varsayımıyla yazılmıştı. Epic #2348 bunu iptal etti: Marketing artık bu
çekirdeğin bir **dikeyi** (`Organization.vertical = "MARKETING"`). Dolayısıyla
dosyalardaki şu varsayımlar **geçersiz**:

| Backlog'un varsaydığı | Gerçekte ne oldu |
| --- | --- |
| Kendi auth'u, davet akışı, rolleri | Bu repo'nun auth'u; `Role` enum'u **donuk** (#2348) |
| Kendi deploy'u, health'i, yedeklemesi, cron'u | Bu repo'nunki; hepsi mevcut |
| `Customer` modeli | `Company` (+ eksik alanlar eklenerek) |
| `LifecycleStage` enum'u | `PipelineStage` satırları + `MARKETING_FUNNEL` preset'i (`src/lib/programTemplates.ts`) |
| Kendi i18n'i | `src/i18n/` + `check:i18n` kapısı |
| Marketing'e özel roller | Rol yok; dikey **yetenek** kısıtlar (`src/lib/verticals.ts`) |

**Bir görevi buradan alıp doğrudan uygulamayın.** Önce `CURATION.md`'ye bakın:
her görev, bu repoda zaten var olana karşı denetlenip **KEEP / ADAPT / DROP**
olarak sınıflandı ve DROP olanların neden gereksiz olduğu, karşılığı olan dosya
adıyla yazıldı.

## Önce oku: veri modeli kararı

Backlog'un hiçbir görevinin kendi başına cevaplayamadığı tek soru var: bu şemada bir
**funnel kaydı hangi satır?** Cevap — hesap = `Company`, funnel kaydı =
`MentorshipRelation` (sahip = `mentorId`, lead kişi = `menteeId`, hesap = `companyId`),
lead kişi = `MENTEE` rolünde bir `User` — [`pipeline-record.md`](pipeline-record.md)
dosyasında, gerekçeleriyle ve neyi **dışladığıyla** birlikte yazılı (epic #2348, açık
karar 1). Bütün epic'ler bunu varsayar. **Maliyet sahibi hâlâ değiştirebilir**; değişmediği
sürece tek bir PR sessizce farklı davranamaz.

## Dosyalar

- `pipeline-record.md` — funnel kaydı nedir (bağlayıcı varsayılan karar)
- `CURATION.md` — görev görev karar listesi (asıl okunacak dosya)
- `backlog/INDEX.md` — devralınan epic tablosu
- `backlog/epic-01..09-*.md` — devralınan epic'ler, olduğu gibi

## Neden olduğu gibi saklandı

Sadece "hâlâ geçerli" olanları taşımak, *neden* bir şeyin elendiğini kaybettirirdi.
Bu dosyalar 89 görevin gerekçesini ve hazır prompt'larını taşıyor; ADAPT edilen bir
görevin orijinal niyetini okumak, onu dikey mimarisine doğru çevirmenin en hızlı yolu.
