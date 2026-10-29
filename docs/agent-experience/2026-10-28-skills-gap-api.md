# 2026-10-28 — Beceri açığı raporu, API dilimi (#1823)

- **`tenantWhere(session)` nullable `orgId` varsayar** (varsayılan org için `OR: [{orgId}, {orgId: null}]`).
  `Requisition.orgId` gibi zorunlu kolonlarda tip hatası verir; orada org'u açıkça adlandır:
  `callerOrgId ?? await defaultOrgId()` (aynı kural).
- **Arka planda başlatılan `next dev`'i durdurmak** bu araçta kabuğu da öldürebiliyor (exit 144).
  `setsid nohup npm run dev … & disown` ile başlatınca sonraki komutlar etkilenmiyor.
- L boyutlu bir issue'yu dilimle: önce saf kural + API + e2e (rol kapısı dahil), sonra panel/export.
  Her dilim kendi başına yayınlanabilir; API dilimi kullanıcıya görünmediği için `patch`, notes yok.
