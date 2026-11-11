# 2026-10-29 — Toplu eşleştirme turları, şema (#1793)

- Issue metinleri "ADMIN check inside the handler" diyor, ama `npm run check:authz` artık
  `session.user.role === 'ADMIN'` karşılaştırmasını yeni rotada reddediyor: yetki
  `requirePermission('<izin>', { request })` ile sorulur (`program.read` okuma, `relation.write`
  eşleştirme yazımı). Bir mentor bu izinleri taşımaz → 403.
- "Nihai durum" kuralları için her yazım beklenen durumu WHERE'de taşıyan bir `updateMany`;
  arada yayınlanmış bir tur sessizce üzerine yazılmaz, 409 döner.
- Statü düzenleme şemasında `PUBLISHED`'ı enum'a hiç koyma: yayın ayrı bir işlem (ilişki, plan
  kapısı, karar kaydı) — PATCH ile oraya gidilemesin, zod 400 versin.
