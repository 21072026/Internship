# 2026-10-23 — Beceriler ekranı MARKETING'de kapatıldı (#3150)

- **Önce `origin/main`'e bak.** Ana checkout'un dalı 100+ commit gerideydi; sorulan ekran
  (`/admin/skills`) yalnızca `origin/main`'de vardı. `git fetch` + taze bir worktree
  (`git worktree add ../X -b <dal> origin/main`) yanlış kodu incelemeyi önler.
- **Bir internship modülünü MARKETING'de kapatmak üç adımdır:** `navLinks.ts`'te
  `capability`, segmentte `gatePage()` çağıran bir `layout.tsx`
  (`nav-route-capability` testi eksikse kırar) ve her API handler'ında `requireCapability()`.
- **Toplu düzenlemede perl'ü `|` ayırıcıyla kullanma:** desende `||` varsa ayırıcı ile
  çakışır ve dosyayı karakter karakter bozar. Sabit metin değiştirmede küçük bir Node betiği
  (`split(GUARD).join(GUARD + ADD)`) güvenli.
- Worktree'de `node_modules` yok: nav birim testleri bile `lucide-react` import ettiği için
  `npm ci` olmadan düşer.
