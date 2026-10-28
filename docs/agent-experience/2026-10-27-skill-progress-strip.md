# 2026-10-27 — Beceri ilerleme şeridi (#1822 son kısım)

- **`pkill -f "next dev"` Bash aracının kendi kabuğunu öldürür** (komut satırında aynı metin
  geçtiği için) → exit 144. Dev sunucusunu PID ile durdur (`pgrep -f next-server` → `kill <pid>`).
- Uzun süren `prisma db push` / `tsc` çıktısını bir dosyaya yönlendir; aksi hâlde araç çıktıyı
  kesebiliyor ya da hiç göstermiyor.
- `origin/main` hızlı ilerliyor: dal açtıktan sonra `npm ci` + `prisma generate` + `db push`
  yapılmazsa tsc başka PR'ların şema/bağımlılık değişikliklerinde düşer (ör. `ProgramEvent`).
- Sunucu bileşeni bir kartı props ile alıp (`t={t.skillConfirm}`) render edebilir; istemci
  kancası (`useT`) gerekmez — portal sayfaları server component.
