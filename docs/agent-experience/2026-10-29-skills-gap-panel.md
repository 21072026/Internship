# 2026-10-29 — Beceri açığı paneli ve `next dev`'in bellek eşiği (#1823)

- **`next dev` bu konteynerde büyük sayfalarda kendini yeniden başlatıyor**
  ("Server is approaching the used memory threshold, restarting…"). Yeniden başlatma
  sırasında tarayıcı 503 (service worker "Offline") ya da `ERR_CONNECTION_REFUSED` görür ve
  e2e, ilgisiz bir yerde "element(s) not found" ile düşer. `/admin/analytics` gibi ağır bir
  sayfayı doğrularken `npm run build && npm start` (prod sunucusu) kullan; dev'in heap'ini
  büyütmek (`NODE_OPTIONS=--max-old-space-size=8192`) yetmedi.
- Bir analytics kartı yeni bir export ekliyorsa tek kapıdan geçir: `/api/admin/export/[dataset]`
  rapor rotasını in-process çağırır, böylece ADMIN / capability / ADVANCED_ANALYTICS kapıları
  dosya için de geçerli olur; ayrı bir export rotası yazma.
- `Select` (`src/components/ui/Select.tsx`) `children` değil `options` prop'u ister.
