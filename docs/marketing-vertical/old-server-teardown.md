# Eski sunucudan (ersah.in / Plesk) Marketing'i sökmek

Marketing CRM artık bu repo'nun bir dikeyi (#2348), `21072026/Marketing` repo'su
kapanıyor ve eski Plesk kutusunda Marketing'e ait hiçbir şey kalmayacak.
**Internship aynı kutuda çalışmaya devam ediyor** — bu dokümanın asıl amacı,
sökümün onu kırmamasını sağlamak.

Veri kaygısı yok: `salevali_crm_test` yalnızca `prisma/seed-demo.mjs`'in ürettiği
**demo veridir**, taşınmayacağına #2348'de karar verildi. Yine de düşürmeden önce
bir dump alınıyor — maliyeti birkaç saniye, alternatifi geri dönüşsüz.

## Sökülecekler (her biri, onu yaratan script'ten)

| Ne | Değer | Kaynak |
| --- | --- | --- |
| Ana container | `salevali-crm-marketing` (port 3300) | `subdomain-deploy.sh:47,92` |
| PR ortamları | `salevali-crm-marketing-pr<N>` (port `3500 + N%100`) | `pr-preview.yml` |
| Image'lar | `ghcr.io/21072026/marketing:*` | `build-image.yml` |
| Plesk subdomain'leri | `marketing.ersah.in`, `marketing-pr<N>.ersah.in` | `subdomain-deploy.sh:120` |
| Ters proxy | `/var/www/vhosts/system/<fqdn>/conf/vhost_nginx.conf` | `subdomain-deploy.sh:151-165` |
| Veritabanı | `salevali_crm_test` | `bootstrap-test-env.sh:30` |
| DB kullanıcıları | `salevali_test`@`localhost` **ve** @`172.17.%` | `bootstrap-test-env.sh:35-36` |
| Env dosyası | `/etc/salevali-crm/test.env` (+ klasörü) | `bootstrap-test-env.sh:41-56` |

## ⛔ DOKUNULMAYACAKLAR — Internship ile paylaşılıyor

1. **Plesk sertifikası `wildcard-ersah.in` ve `/etc/nginx/ssl/ersah.in.{cer,key}`.**
   Internship'in PR preview'ları da aynı sertifikayı import ediyor
   (`internship/infra/server/topic-deploy.sh:442-443`). Silinirse onların TLS'i gider.
2. **MariaDB servisinin kendisi.** Yalnızca `salevali_crm_test` veritabanı ve
   `salevali_test` kullanıcıları düşürülür; `internship_crm*` veritabanlarına ve
   `crm*` kullanıcılarına dokunulmaz.
3. **`docker image prune -a` ASLA.** Marketing'in kendi teardown script'i
   (`subdomain-teardown.sh:31`) `prune -af` çağırıyordu — bu, kutudaki *kullanılmayan
   tüm* image'ları siler, Internship'inkiler dahil. Bu doküman bilerek yalnızca
   ada göre `docker rmi` kullanıyor. (Internship kendi script'inde `prune -f`
   kullanıyor: sadece dangling, güvenli.)
4. **`ersah.in` ana domain'i ve postası.** Aşağıdaki mail tuzağına bakın.
5. Internship'in container'ları (`internship-crm*`) ve portları (3200–3202, 3400–3499).

## ☠️ Mail tuzağı — subdomain'i silmeden ÖNCE oku

`docs/server-migration.md` bu dersi pahalıya öğrendi: **bir Plesk subdomain'ini
silmek, onun mail domain'ini de siler.** `crm.ersah.in` kaldırıldığında
`reply@crm.ersah.in` kutusu da gitti; uygulamanın gelen-posta okuyucusu 60 saniyede
bir bağlanmaya devam edince dovecot `auth_failed` üretti, fail2ban IP'yi banladı,
tekrarlar `recidive` jail'ini tetikledi ve **7 günlük, tüm portları kapsayan** bir
ban çıktı — giden posta da öldü. Hata mesajı sadece `Connection timeout` diyordu.

`marketing.ersah.in` için bunun geçerli olup olmadığı **silmeden önce** ölçülmeli:

```bash
plesk bin mail --info marketing.ersah.in 2>&1 | head        # posta kutusu var mı
grep -ri 'marketing\.ersah\.in' /etc/postfix /etc/dovecot 2>/dev/null | head
grep -ri 'marketing\.ersah\.in' /etc/internship-crm/ 2>/dev/null   # SMTP/IMAP hedefi mi
```

Üçü de boşsa risk yok. Bir posta kutusu veya referans çıkarsa: önce o referansı
kes (env'i düzelt, container'ı **yeniden yarat** — `docker restart` env dosyasını
yeniden okumaz), sonra subdomain'i sil.

## Sıra (her adımın neden orada olduğu yazılı)

### 0 · Dondur — yoksa söktüğünü geri kurar
`21072026/Marketing` repo'sundaki `deploy-test.yml` ve `pr-preview.yml` hâlâ
tetiklenebilir durumda; main'e bir push veya bir PR kapanışı, sildiğin container'ı
geri getirir. Repo'yu silmek ya da Actions'ı kapatmak **ilk** adımdır.

### 1 · Envanteri doğrula (salt-okunur)
```bash
docker ps -a --filter 'name=salevali' --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
docker images 'ghcr.io/21072026/marketing' --format '{{.Repository}}:{{.Tag}}'
plesk bin subdomain --list 2>/dev/null | grep -i marketing
mysql -e "SELECT table_schema, COUNT(*) FROM information_schema.tables \
          WHERE table_schema LIKE 'salevali%' GROUP BY 1;"
ls -la /etc/salevali-crm/
```
Beklenenden fazlası çıkarsa dur ve raporla — envanter bu dokümandan değil, kutudan
gelmeli.

### 2 · Mail kontrolü
Yukarıdaki "mail tuzağı" komutları. Sonucu not et.

### 3 · Veritabanını yedekle, sonra düşür
```bash
mysqldump --single-transaction --routines salevali_crm_test \
  | gzip > /var/backups/salevali_crm_test-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
gzip -t /var/backups/salevali_crm_test-*.sql.gz && echo "dump OK"

mysql -e "DROP DATABASE IF EXISTS salevali_crm_test;
          DROP USER IF EXISTS 'salevali_test'@'localhost';
          DROP USER IF EXISTS 'salevali_test'@'172.17.%';
          FLUSH PRIVILEGES;"
```
**Container'lardan önce değil, sonra da değil — tam burada.** Container'lar hâlâ
ayaktayken düşürmek, uygulamanın bağlantı hatalarıyla log doldurmasına yol açar;
çok geç düşürmek ise kimsenin kullanmadığı bir veritabanını unutmaya davettir.
Parolayı komut satırına yazma: `mysql`/`mysqldump` root'ta Plesk'in
`~/.my.cnf`'ini kullanır, parola `ps` çıktısına düşmemeli.

### 4 · Container'ları ve SADECE Marketing image'larını kaldır
```bash
for c in $(docker ps -aq --filter 'name=salevali-crm-'); do
  docker stop "$c" >/dev/null; docker rm "$c" >/dev/null
done
docker images 'ghcr.io/21072026/marketing' -q | sort -u | xargs -r docker rmi
```
`docker image prune -a` **yok**. Ada göre silmek, Internship'in image'larını
kazara almanın tek güvenli yolu.

### 5 · Plesk subdomain'lerini kaldır (adım 2 temiz çıktıysa)
```bash
for s in $(plesk bin subdomain --list | grep -oE '^marketing(-pr[0-9]+)?'); do
  plesk bin subdomain --remove "$s" -domain ersah.in
done
```
Sertifikaya dokunma. `plesk bin certificate --remove wildcard-ersah.in` **yasak**.

### 6 · Env dosyasını sil
```bash
shred -u /etc/salevali-crm/test.env 2>/dev/null || rm -f /etc/salevali-crm/test.env
rmdir /etc/salevali-crm 2>/dev/null || true
```
İçinde üretilmiş `NEXTAUTH_SECRET`, `HEALTH_TOKEN`, `CRON_SECRET` ve DB parolası var;
düz `rm` yerine `shred` tercih edilir.

### 7 · Deploy anahtarını geri çek
Marketing deploy'u `SSH_PRIVATE_KEY` secret'ıyla bu kutuya giriyordu. O anahtar
Internship için de kullanılmıyorsa `~/.ssh/authorized_keys`'ten çıkar. Repo silinince
secret gider ama **anahtar kutuda kalır** — bu, yetkisi kalmamış bir erişim yolu demektir.

### 8 · Internship'in sağlam olduğunu kanıtla
```bash
docker ps --filter 'name=internship-crm' --format '{{.Names}}\t{{.Status}}'
curl -fsS https://crm.ersah.in/api/health && echo
mysql -e "SHOW DATABASES;" | grep internship
plesk bin certificate --info wildcard-ersah.in -domain ersah.in >/dev/null && echo "sertifika yerinde"
```
Dördü de geçmeden söküm bitmiş sayılmaz.

## Ne CI'dan koşabilir, ne insan ister

Adım 1–6 bir script'tir ve `infra/run-over-ssh.sh` deseniyle bir runner'dan
koşabilir. **İnsan gerektirenler:** adım 0 (repo/Actions kapatma), adım 2'nin
yorumu (mail kutusu çıkarsa ne yapılacağı bir karardır), adım 7 (anahtar
yönetimi). Bu yüzden burada tek bir "hepsini yap" script'i yok: sökümün yarısı
karar, yarısı komut.

## Sonuç — söküm 2026-09-15'te yapıldı

Adım 0 daha önce tamamlanmıştı (`21072026/Marketing` repo'su silindi, deploy
workflow'ları artık tetiklenemez). Kalanı `infra/marketing-teardown.sh` ile bir
GitHub Actions runner'ından, iki fazlı olarak koşturuldu; script ve workflow bu
commit'te silindi — bir kerelik, root yetkili bir araç işini bitirdikten sonra
repoda durmamalı.

**Envanter fazı (salt-okunur).** Kutuda bulunan: tek container
`salevali-crm-marketing` (3 gündür `Exited (1)`), tek image
`ghcr.io/21072026/marketing:test-…`, tek subdomain `marketing.ersah.in`,
`salevali_crm_test` (11 tablo), `/etc/salevali-crm/test.env` (874 B). PR ortamı
kalmamıştı. **Mail kontrolü temiz** — ne posta kutusu ne referans, yani 5. adımın
önü açıktı.

**Söküm fazı.** Dump doğrulandı (2810 B, 11 tablo) ve
`/var/backups/salevali_crm_test-20260915T075304Z.sql.gz` olarak duruyor; ardından
veritabanı ve iki kullanıcı düşürüldü, container ve image ada göre silindi,
`marketing.ersah.in` Plesk'ten kaldırıldı, env dosyası shred edildi. Sertifikaya
dokunulmadı.

### 8. adımın üç uyarısı yanlış alarmdı

Run kırmızı bitti, çünkü Internship doğrulaması üç `!!` verdi: "internship-crm
container'ı çalışmıyor", "internship veritabanı yok", "wildcard sertifikası
eksik". Üçü de **kontrolün varsayımı** yanlış olduğu için çıktı, kutuda bir şey
kırıldığı için değil — script zaten beyaz listesi dışında hiçbir şeye dokunmadı
ve neyi sildiğini tek tek logladı. Dışarıdan ölçülen gerçek durum:

- `https://crm.interncrm.com/api/health` → **200**, `version 0.202.0-beta`,
  `replica: internship-crm`. Uygulama ayakta.
- `*.ersah.in` wildcard sertifikası **geçerli** (Let's Encrypt, 10 Aralık 2026).
  Plesk'in sertifika deposunda `wildcard-ersah.in` adıyla aranması yanlıştı;
  sertifika acme.sh tarafından `/etc/nginx/ssl` altına kuruluyor
  (`infra/server/bootstrap.sh`).
- `crm.ersah.in` → 301 → `interncrm.com`; Internship'in kanonik adı artık
  interncrm.com.
- `marketing.ersah.in` artık kendi vhost'u olmadığı için Internship'e düşüyor
  (health cevabı `replica: internship-crm` diyor) — yani Marketing gitti.

Container filtresi (`name=internship-crm`) ve veritabanı adı grep'i ("internship"
içeren bir DB) de aynı cinsten varsayımlardı; prod'un gerçek container ve DB adı
`ENV_FILE` içinden geliyor, repoda sabit değil. Ders: **bir teardown script'inin
son doğrulaması, doğrulayacağı şeyin adını tahmin etmemeli** — dışarıdan HTTP ve
TLS ölçmek, isim eşleştirmekten daha güvenilir bir "hâlâ ayakta mı" kanıtı.

### Hâlâ insanda olan tek iş

`~/.ssh/authorized_keys` **6. satır**, yorumu `marketing-crm-github-actions`:
Marketing deploy'unun bu kutuya girdiği anahtar. Repo silinince secret gitti ama
anahtar kutuda duruyor — sahibi olmayan bir erişim yolu. Internship kendi
anahtarını kullandığı için bu satır güvenle çıkarılabilir.
