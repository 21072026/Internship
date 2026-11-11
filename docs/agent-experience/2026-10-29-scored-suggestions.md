# 2026-10-29 — Skorlanan mentor önerileri (#1787)

- **"İkinci bir eşleştirici yazma" kuralını korumanın yolu boyutu genişletmekti.** #1821'in
  kanonik beceri + komşuluk kuralı yalnız rotadaydı; `scoreMatch()`'in `skills` boyutu ise serbest
  metin. Rotayı motora taşırken komşuluk kaybolacaktı (e2e kırılırdı). Çözüm: `ScoreContext.skillGraph`
  — çağıran grafiği verirse `skills` boyutu aynı saf `skillOverlap()`'i kullanır, vermezse eski
  davranış (dry run ve requisition fit değişmedi).
- **Kural setinin üstündeki kurallar** (mentorun "yeni mentee almıyorum"u) skor kuralı değil; ayrı
  saf bir katmanda (`suggestMentors` → `honourNotAccepting`) ve var olan `capacityHeadroom`
  boyutuna raporlanıyor, böylece ekranlar yeni bir etiket öğrenmek zorunda kalmıyor.
- Havuzda ADMIN'ler de mentor olarak var (`loadMentorPool`): "öneri listesi tam olarak şu" diyen bir
  e2e, org'un admin'ini sıfır skorla sonda bulur — `slice` ile karşılaştır.
