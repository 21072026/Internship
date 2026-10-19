# MARKETING dikeyi — tasarım notları

Bu klasör MARKETING dikeyinin (`Organization.vertical = "MARKETING"`, epic #2348)
tasarım notlarını tutar: funnel kaydının ne olduğu, aşama kararları, demo formu, posta
kampanyaları, satış iletişiminin kanal kuralları ve canlıya alma listesi.

Marketing CRM, bu çekirdeğin bir **dikeyidir** — ayrı bir ürün ya da ayrı bir repo değil.
Belgeler yalnızca bu repo'nun genel kararlarını anlatır; tek bir kiracıya özgü olan her şey
(bir müşterinin kendi sistemleri, alan adları, fiyatları, sözleşme şartları) burada
**tutulmaz** — kiracı verisi olarak veritabanında ya da bakımcının kendi notlarında durur.

## Dikey kararı neyi değiştirdi

Ayrı bir Marketing CRM'in varsayacağı her şeyin bu repoda bir karşılığı var; ikinci bir
kopyası yazılmaz:

| Ayrı bir CRM'in varsayacağı | Bu repoda |
| --- | --- |
| Kendi auth'u, davet akışı, rolleri | Bu repo'nun auth'u; `Role` enum'u **donuk** (#2348) |
| Kendi deploy'u, health'i, yedeklemesi, cron'u | Bu repo'nunki; hepsi mevcut |
| `Customer` modeli | `Company` (+ eksik alanlar eklenerek) |
| `LifecycleStage` enum'u | `PipelineStage` satırları + `MARKETING_FUNNEL` preset'i (`src/lib/programTemplates.ts`) |
| Kendi i18n'i | `src/i18n/` + `check:i18n` kapısı |
| Marketing'e özel roller | Rol yok; dikey **yetenek** kısıtlar (`src/lib/verticals.ts`) |
| Ayrı kullanıcı tabanı (aynı kişi iki ayrı uygulamada, aynı e-posta) | Tek `User` tablosu, ama e-posta **dünya başına** benzersiz: aynı kişi iki ürüne aynı adresle, ayrı hesap ve ayrı parolayla girer; hangisini kullandığını girdiği **host** belirler — [`../worlds.md`](../worlds.md) |

## Önce oku: veri modeli kararı

Bu şemada bir **funnel kaydı hangi satır?** Cevap — hesap = `Company`, funnel kaydı =
`MentorshipRelation` (sahip = `mentorId`, lead kişi = `menteeId`, hesap = `companyId`),
lead kişi = `MENTEE` rolünde bir `User` — [`pipeline-record.md`](pipeline-record.md)
dosyasında, gerekçeleriyle ve neyi **dışladığıyla** birlikte yazılı (epic #2348, açık
karar 1). Bütün MARKETING işleri bunu varsayar. **Maliyet sahibi hâlâ değiştirebilir**;
değişmediği sürece tek bir PR sessizce farklı davranamaz.

## Dosyalar

- `pipeline-record.md` — funnel kaydı nedir (bağlayıcı varsayılan karar)
- `funnel-decision.md` — MARKETING_FUNNEL aşamaları ve DEAL_WON sonrası müşteri
  durumu (#2572) — karar, 2026-10-07
- `../worlds.md` — bir kişi, iki dünya: aynı e-posta iki üründe ayrı hesap, giriş
  yapılan host'a göre ürün seçimi (#2590)
- [`../usage-feed.md`](../usage-feed.md) — ürün kullanım beslemesinin veri sözleşmesi (#2445)
- [`../integrations/account-events.md`](../integrations/account-events.md) — upstream bir
  ürünün hesap olaylarının CRM'e alınması (#2450)
- `postal-campaigns.md` — giden müşteri kazanımı: yasal Briefwerbung kampanyası, Werbewiderspruch +
  engel listesi, DIN 5008 mektup, kampanya atfı ve `MARKETING_OPERATOR_*` (#2697)
- `sales-email-capture.md` — satış e-postalarının CRM'e düşmesi: BCC-to-CRM, gövdesiz (karar #2564, uygulama #2809)
- `go-live-checklist.md` — ilk gün / ilk hafta kontrol listesi ve ölçüm (#2581)
- `stage-preset.md` — mevcut bir MARKETING tenant'ını güncel aşama setine getiren operatör CLI'ı (#2959)
- `outreach-compliance.md` — MARKETING satış iletişimi kanal kuralları (UWG § 7 /
  DSGVO, #2576); CRM izin kodlarının (#2577) hukuki metni — hukuki danışmanlık değildir,
  Fachanwalt incelemesi bekliyor
