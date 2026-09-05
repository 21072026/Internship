# Sunucu taşıma: Plesk/ersah.in → Oracle ARM/interncrm.com

Takip issue'su: [#2166](https://github.com/21072026/Internship/issues/2166)

Bu dosya **çalıştırma sırasıdır**, mimari anlatımı değil. Mimarinin gerekçeleri
`infra/server/bootstrap.sh` içindeki yorumlarda ve [`infra/README.md`](../infra/README.md)'de.

## Neden taşınıyoruz

`infra/README.md`'de anlatılan karmaşanın neredeyse tamamı tek bir sebepten
doğdu: **Plesk 80/443'ü tutuyordu.** `plesk bin subdomain --create`, Plesk
vhost'larıyla eşleşmek zorunda olan `listen <IP>:443` adres grubu, `conf.d`'ye
elle nginx vhost üretimi, ayrı bir acme.sh wildcard akışı — hepsi panelin
etrafından dolaşma maliyeti. Yeni kutuda panel yok; 80/443'ü Caddy alıyor.

| | Eski | Yeni |
|---|---|---|
| Host | s.ersah.in | s.interncrm.com (92.5.120.186) |
| Sağlayıcı | Plesk sunucu | Oracle Cloud, Ampere A1 (KVM) |
| Kaynak | — | 4 vCPU · 23 GB RAM · 193 GB |
| OS | — | Ubuntu 26.04.1 LTS |
| **Mimari** | amd64 | **arm64 (aarch64)** |
| Panel | Plesk | yok |
| Reverse proxy | Plesk nginx | Caddy |
| Veritabanı | MariaDB | MySQL 8.0 (CI ile aynı) |
| DNS | Cloudflare | Cloudflare |

---

## Faz 0 — sunucu bootstrap'i · TAMAMLANDI

```bash
scp infra/server/bootstrap.sh ubuntu@s.interncrm.com:/tmp/
ssh ubuntu@s.interncrm.com 'sudo ACME_EMAIL=m@ersah.in bash /tmp/bootstrap.sh'
```

Idempotent — ikinci çalıştırma hiçbir şeyi değiştirmez. Kurulan:
Docker 29.8 + compose/buildx · Caddy 2.11 (80/443) · MySQL 8.0.46
(`127.0.0.1:3306`) · fail2ban · 4G swap · journald 500M limiti · Tailscale
(kurulu, login yapılmamış) · gh, lazydocker, btop, ncdu, ripgrep, tmux.

**Neden ufw yok.** İki sebep, ikisi de bu makinaya özel. (1) Oracle imajı filter
tablosunu zaten `/etc/iptables/rules.v4` + netfilter-persistent üzerinden
yönetiyor, ve OUTPUT'taki `InstanceServices` zinciri süs değil — iSCSI'yi
(3260; bazı shape'lerde boot volume oradan bağlı), metadata servisini ve NTP'yi
kapsıyor. ufw aynı tablonun ikinci sahibi olurdu ve netfilter-persistent'ın
`iptables-restore`'u açılışta tabloyu **flush** ediyor: en son başlayan sessizce
kazanır. (2) Docker portları nat/DOCKER zincirlerine yazarak yayınlıyor, ufw
bunu görmüyor — 3306'yı ufw'da kapatmak `-p 3306:3306`'yı dışarıdan erişilebilir
olmaktan çıkarmazdı. Bu yüzden: Oracle'ın kendi dosyası genişletildi, ve her
container `127.0.0.1`'e bağlanıyor.

**Sırlar** `/opt/internship-crm/secrets/mysql.env` (0600) içinde üretildi ve
hiçbir yere basılmadı. `DATABASE_URL`'i GitHub secret'ına oradan kopyala —
chat'ten, ticket'tan veya commit'ten değil.

---

## Faz 1 — senin yapman gerekenler

Bunların hiçbiri sunucunun içinden yapılamaz.

### 1.1 Oracle VCN: 80 ve 443 ingress'i aç · **BLOCKER**

Oracle'da güvenlik duvarı **çift katmanlı**. Kutunun içindeki iptables artık
80/443'e izin veriyor, ama VCN hâlâ kesiyor — doğrulandı:

```
$ nc -z 92.5.120.186 80   → blocked
$ nc -z 92.5.120.186 443  → blocked
$ nc -z 92.5.120.186 22   → open
```

Konsol → **Networking → Virtual Cloud Networks → <VCN> → Security Lists →
Default Security List → Add Ingress Rules**. İki kural:

| Stateless | Source CIDR | IP Protocol | Destination Port Range |
|---|---|---|---|
| Hayır | `0.0.0.0/0` | TCP | `80` |
| Hayır | `0.0.0.0/0` | TCP | `443` |

Instance'a NSG bağlıysa kuralları oraya da ekle (NSG, security list'i **ezmez**;
ikisi birleşir, ama NSG boşsa etkisi olmaz).

Doğrulama — kendi makinenden:

```bash
curl -sk https://s.interncrm.com/ ; echo
# beklenen: internship-crm: caddy is up
```

### 1.2 DNS kayıtları (Cloudflare)

Cloudflare'de `interncrm.com`, apex şu an **proxied** (104.21.76.4 / 172.67.184.199).

Eklenecek kayıtlar — hepsi `92.5.120.186`, **Proxy KAPALI (gri bulut)**:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `crm` | 92.5.120.186 | **kapalı** |
| A | `crm-preview` | 92.5.120.186 | **kapalı** |
| A | `*` | 92.5.120.186 | **kapalı** |
| A | `s` | 92.5.120.186 | kapalı (mevcut) |

Gri bulut tercih değil, **zorunluluk**: `TRUSTED_PROXY_COUNT` (`src/lib/rateLimit.ts`)
bugün her ortamda `1`. Bir hostname turuncu buluta alınırsa aradaki hop sayısı 2
olur ve rate limiter herkesi Cloudflare edge IP'sine bucket'lar — tek kişi
hepsini throttle'lar. `infra/README.md`'deki uyarının aynısı.

Apex (`interncrm.com`) şimdilik olduğu gibi kalabilir; taşımanın hiçbir adımı
ona dokunmuyor.

### 1.3 Wildcard TLS sertifikası · **BLOCKER, ve tek Cloudflare token'ı gereken yer**

Caddy hostname başına Let's Encrypt sertifikasını kendi alabilir, **ama bu proje
için yetmez.** Son 100 PR 9 günde merge edilmiş — haftada ~78 PR, ve her PR
kendi `crm-pr<N>.interncrm.com` ortamını alıyor. Let's Encrypt'in limiti
**alan adı başına haftada 50 sertifika**. Yani hostname-başına sertifika üçüncü
gün duvara çarpar ve topic ortamları sessizce TLS'siz kalır.

Çözüm eski sunucudakiyle aynı ve script'i zaten yazılmış: `*.interncrm.com`
için **tek** wildcard sertifika, DNS-01 ile. `infra/acme-issue-wildcard.sh`
bunu uçtan uca yapıyor (TXT kaydını oluşturur, doğrular, siler, cron'a yeniler).

Cloudflare'de **scoped** bir API token üret (My Profile → API Tokens → Custom):

```
Zone → DNS  → Edit
Zone → Zone → Read
Zone resources → Include → Specific zone → interncrm.com
```

Sonra **sunucuda, kendi shell'inde**:

```bash
ssh ubuntu@s.interncrm.com
export CF_Token='<token>'
sudo -E DOMAIN=interncrm.com \
        CERT_DIR=/etc/caddy/certs \
        RELOAD_CMD='systemctl reload caddy' \
        bash /tmp/acme-issue-wildcard.sh
```

Sertifika `/etc/caddy/certs/interncrm.com.cer` + `.key` olarak kurulur; Faz 2'de
topic site dosyaları bunu `tls` direktifiyle gösterecek. acme.sh yenilemeyi
cron'a kendisi ekler.

> Token'ı chat'e, commit'e veya bir issue'ya yapıştırma. `infra/README.md`'nin
> dediği gibi: bir yere düşmüşse yanmıştır, Cloudflare'den derhal döndür.
> acme.sh token'ı `~/.acme.sh` altında 600 ile saklar, yenilemeler için bir daha
> istemez.

Alternatif (token istemez): Cloudflare **Origin CA** sertifikası — 15 yıllık,
ücretsiz, ama panelden üretiliyor ve turuncu bulutun açık kalmasını şart koşuyor.
Turuncu bulut 1.2'deki `TRUSTED_PROXY_COUNT` sorununu geri getirdiği için
seçilmedi.

### 1.4 Tailscale

```bash
ssh ubuntu@s.interncrm.com 'sudo tailscale up'
```

Çıkan URL'yi tarayıcında aç ve onayla. Bu bittikten sonra:

- SSH'ı public internetten tamamen çekebilirsin (22'yi sadece tailnet'e aç),
- MySQL'i hiç dışarı açmazsın — eski sunucuda **3306 port exposure** aylarca
  açık bir bulgu olarak durdu, burada hiç doğmuyor,
- preview/topic ortamlarını istersen sadece tailnet'e servis edersin.

### 1.5 GitHub Actions self-hosted runner

Deploy pipeline'ı (gate → build → deploy) self-hosted bir runner'a dayanıyor ve
`runner-watchdog.yml` onu bekliyor. Kayıt token'ı 1 saat geçerli, o yüzden bunu
sen çalıştırmalısın:

Repo → **Settings → Actions → Runners → New self-hosted runner → Linux / ARM64**.
Verdiği `./config.sh --url ... --token ...` komutunu sunucuda çalıştır, sonra:

```bash
sudo ./svc.sh install ubuntu && sudo ./svc.sh start
```

Runner'ı `ubuntu` olarak kur (docker grubunda). **arm64** paketini seçtiğinden
emin ol — x64 paketi bu makinada çalışmaz.

---

## Faz 2 — repo tarafı (ayrı PR'lar)

| # | İş | Neden |
|---|---|---|
| 1 | `build-image.yml` → `linux/arm64` manifest | **Gerçek blocker.** Bugünkü imaj `ubuntu-latest` üzerinde amd64 üretiliyor; bu kutuda `docker run` `exec format error` verir — pull sırasında değil, çalıştırma sırasında. buildx ile multi-arch, ya da tamamen arm64 runner. |
| 2 | Caddy tabanlı routing | `topic-deploy.sh`/`topic-teardown.sh` içindeki Plesk'e özel her şey siliniyor. Topic başına route iki satıra iniyor: `crm-pr5.interncrm.com { reverse_proxy 127.0.0.1:3305 }` + wildcard sertifika için `tls`. |
| 3 | `BASE_DOMAIN` = `interncrm.com` | Zaten parametrik (`topic-deploy.sh`); workflow'lardaki sabit `ersah.in`'ler taranmalı. |
| 4 | Deploy workflow'ları yeni hosta | `deploy-prod.yml`, `deploy-preview.yml`, `topic-preview.yml`, `topic-sweep.yml`. |
| 5 | Yedek hedefi | `infra/backup-db.sh` duruyor, `BACKUP_DIR` ve off-site hedef değişiyor. |

---

## Faz 3 — veri taşıma ve kesme anı

Faz 1 ve 2 bitmeden başlama. Sıra:

1. Eski sunucuda bakım moduna al (ya da düşük trafikli bir saat seç).
2. `mysqldump` → yeni sunucuya kopyala → restore. **Dump'ta gerçek kişisel veri
   var** (CV'ler, telefonlar, mentor notları — `infra/backup-db.sh` başlığındaki
   uyarı): 0600, sadece iki kutu arasında, laptopta bırakma.
3. Yeni sunucuda `prisma db push` + backfill'ler, ardından `/api/health`.
4. DNS TTL'ini kesmeden **önce** 60 sn'ye indir.
5. DNS'i çevir, doğrula, eskiyi 1 hafta ayakta bırak (geri dönüş için).

**Geri dönüş:** DNS'i eski IP'ye çevirmek. Bu yüzden eski kutu ve veritabanı
kesme sonrası bir hafta silinmiyor.

---

## Doğrulama listesi

```bash
# kutunun içi
ssh ubuntu@s.interncrm.com 'sudo iptables -S INPUT'          # 22/80/443 REJECT'ten önce
ssh ubuntu@s.interncrm.com 'curl -sk https://localhost/'     # caddy is up
ssh ubuntu@s.interncrm.com 'docker ps'                       # internship-mysql healthy

# dışarıdan (Faz 1.1'den sonra)
curl -sk https://s.interncrm.com/
curl -s https://crm.interncrm.com/api/health | jq
```
