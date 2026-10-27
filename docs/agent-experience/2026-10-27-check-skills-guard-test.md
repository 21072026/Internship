# 2026-10-27 — `check:skills` guard'ının kendisi test edildi (#1816)

- **Issue açık diye iş yapılmamış sanma.** #1816'nın vocabulary'si, `check:skills`'i, CI adımı ve
  org başına seed'i (`backfill-skill-taxonomy.mjs` + `ensureSkillTaxonomy()`) zaten main'deydi —
  issue yalnızca kapatılmamıştı. Kod tabanında `grep` + `git log -- <dosya>` ile başla, sonra
  kabul kriterlerinden gerçekten eksik olanı bul.
- **Yeşil bir guard, çalışan bir guard değildir.** Eksik olan tek kriter "guard üç hata sınıfını
  yakalıyor"un kanıtıydı. `scripts/check-skills.mjs` bir fixture modülünü argüman olarak alıyor
  (`check-stage-keys.mjs` ile aynı hile): test gerçek seed'i klonlayıp tek bir kusur enjekte
  ediyor, `spawnSync` ile script'i koşturuyor ve exit≠0 + mesajı doğruluyor. Dokunulmamış klonun
  geçtiği ayrı bir test, düşen testin fixture gürültüsü değil enjekte kusur olduğunu kanıtlıyor.
- Yeni test dosyası mevcut `test:skill-vocabulary` script'ine eklendi; CI zaten onu koşturuyor,
  `ci.yml`'e dokunmaya gerek kalmadı.
