# Güvenlik denetimi playbook'u / Security audit playbook

Bu doküman, 2026-07-28'de çalışan uygulama üzerinde yapılan güvenlik denetiminin
**tekrar çalıştırılabilir** tarifidir. Amaç: bir sonraki denetimde sıfırdan
başlamamak, aynı tuzaklara düşmemek ve neyin zaten temiz olduğunu bilmek.

Kök takip issue'su: **#951** · Epic'ler: #814, #816, #818, #821, #823, #825, #827, #829

> **Kapsam kuralı:** Bu playbook yalnızca **kendi lokal ortamınızda** ve **sentetik
> veriyle** çalıştırılmak içindir. Prod/preview ortamına yük veya saldırı testi
> yapmayın — [`DATA_ACCESS_POLICY.md`](DATA_ACCESS_POLICY.md) gereği gerçek PII'ya
> hiç dokunulmaz. Dışarıdan gelen zafiyet bildirimleri için `SECURITY.md` (bkz. #901).

---

## 1. Ortam kurulumu (Claude Code web container)

Bu container'da **Docker daemon yok** — `docker compose -f docker-compose.dev.yml up -d`
çalışmaz (`/var/run/docker.sock` yok; `service docker start` ulimit hatası verir).

Çalışan yol — apt ile MariaDB:

```bash
npm install                       # bağımlılıklar preinstall DEĞİL

apt-get update                    # ← bu şart: bayat apt listesi 404 verir
DEBIAN_FRONTEND=noninteractive apt-get install -y mariadb-server
service mariadb start

# root socket-auth kullanıyor; Prisma için parolalı kullanıcı gerekiyor
mariadb -e "CREATE DATABASE IF NOT EXISTS internship_crm;
            CREATE USER IF NOT EXISTS 'crm'@'%' IDENTIFIED BY 'crm';
            GRANT ALL PRIVILEGES ON *.* TO 'crm'@'%'; FLUSH PRIVILEGES;"
```

`.env` (gitignore'da — `.env` ve `.env.*` kapsanıyor):

```bash
DATABASE_URL="mysql://crm:crm@127.0.0.1:3306/internship_crm"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="local-dev-only-secret-not-a-real-one"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
SEED_ADMIN_EMAIL="admin@example.com"
SEED_ADMIN_PASSWORD="ChangeMe123!"
```

```bash
npx prisma generate && npx prisma db push --skip-generate
npx prisma db seed        # ilk ADMIN
npm run seed:demo         # 3 mentor · 8 mentee · 2 company · 12 interaction · 8 relation
npm run dev
```

**Prisma `mysql` provider'ı MariaDB 10.11 ile sorunsuz çalıştı** — şema uyumsuzluğu
yaşanmadı.

⚠️ `seed:demo` bir **SOURCE** kullanıcısı üretmiyor. En kritik kapsamlama boşluğu
tam bu rolde çıktığı için elle oluşturmak gerekti. Seed'e eklenmesi #899'un kabul
kriterlerinde:

```js
await p.user.create({ data: { email: 'source.probe@demo.example.com',
  password: await bcrypt.hash('DemoPass123!', 12), fullName: 'Probe Source User',
  role: 'SOURCE', skills: [], emailVerified: true, isActive: true, sourceId: src.id } });
```

## 2. Playwright kurulumu

CLAUDE.md "eksik sürümü symlink'le" diyor ama **bu işe yaramıyor**: kurulu 1194
build'inin dizin yapısı `chrome-linux/headless_shell`, Playwright 1.61 ise
`chrome-headless-shell-linux64/chrome-headless-shell` arıyor.

Çalışan çözüm — `executablePath` ver:

```js
import { chromium } from '/home/user/Internship/node_modules/@playwright/test/index.mjs';
//        ↑ scratchpad'den çalıştırırken mutlak yol şart, '@playwright/test' çözülmüyor

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
});
```

`playwright install` **çalıştırmayın** (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).

### Login otomasyonu — hidrasyonu bekleyin

`goto` + hemen `click` yaparsanız React hydrate olmadan **native GET submit**
tetiklenir ve parola URL query string'ine düşer:

```
/auth/signin?email=admin%40example.com&password=ChangeMe123%21
```

```js
await page.goto(`${BASE}/auth/signin`, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);                       // hidrasyon
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', pass);
await Promise.all([
  page.waitForURL(u => !u.pathname.startsWith('/auth/signin'), { timeout: 30000 }).catch(() => {}),
  page.click('button[type="submit"]'),
]);
```

> Bu bir test tuzağı değil, **gerçek bulgu** çıktı: auth formlarında `method="post"`
> yok → #873.

Sonra `context.storageState()` ile her rolün çerezini kaydedin; API probe'ları
tarayıcı açmadan bu çerezlerle atılır.

## 3. Yöntem — rol × endpoint matrisi

```mermaid
flowchart TD
  S1["1· Lokal DB + seed<br/>(SOURCE dahil 5 rol)"] --> S2
  S2["2· Playwright ile her rolde login<br/>storageState kaydet"] --> S3
  S3["3· Tüm sayfaları gez<br/>status + konsol hatası + screenshot"] --> S4
  S4["4· Rol × endpoint matrisi<br/>her hücre: allow / deny / own"] --> S5
  S5["5· Beklenti ihlali = bulgu"] --> S6
  S6["6· Kod okuyarak kök neden<br/>+ dosya:satır"]
  style S5 fill:#ffdddd,stroke:#d73a4a,stroke-width:2px
```

### ⚠️ En önemli ders: status kodu tek başına YETMEZ

En kritik bulgu (#847 — COMPANY/SOURCE tüm görüşme kayıtlarını okuyor) **`200`
dönüyordu**. Sızıntı dönen satırların *içeriğindeydi*. Doğru kontrol:

```js
const r = await fetch('/api/interactions', { headers: { cookie: ck(role) } });
const j = await r.json();
// status DEĞİL — sahiplik kontrol et:
const owners = new Set(j.interactions.map(i => i.relation?.mentee?.fullName));
console.log(role, r.status, 'rows:', j.interactions.length, 'distinct mentees:', owners.size);
```

### Yanlış pozitif filtreleri

| Belirti | Anlamı | Yapılacak |
|---|---|---|
| `405` | Route o HTTP metodunu desteklemiyor | Bulgu **değil**, doğru metodu kullan |
| `403` beklerken `403` ama iş akışı kırık | Plan/entitlement kapısı olabilir | Kodu oku, güvenlik sanma |
| Boş `[]` dönmesi | Doğru filtreleniyor **olabilir** | Veri olan bir ilişkiyle tekrar dene |

İlk taramada 10 "bulgu" çıktı; **6'sı `405` yanlış pozitifiydi**, 1'i doğru
filtreleme. Gerçek olan 2 taneydi.

## 4. Bu denetimde TEMİZ çıkanlar (regresyon koruması)

Bunlar canlı test edildi ve doğru davrandı — **bir değişiklik bunları bozarsa
regresyondur**:

| Alan | Kanıt |
|---|---|
| CV erişimi | MENTEE → başka mentee = `403`; MENTOR → başka mentorun mentee'si = `403` |
| Belge erişimi | `canAccessUserDocs` — aynı desen, `403` |
| Mesaj thread'i | Katılımcı olmayan = `403`; yabancı thread'e yazma = `403` |
| Mesaj eki | Thread katılımcısı değilse `403` |
| İlişki notları | Mentee kendi hakkındaki **özel mentor notlarını** göremiyor ✅ |
| Yabancı ilişkiye yazma | MENTOR → başka ilişkiye interaction = `403` |
| Yetki yükseltme | `PUT /api/profile` ile `role: 'ADMIN'` geçmiyor (zod allowlist) |
| Admin uçları | MENTEE/MENTOR/COMPANY hepsinden `401` |
| Güvenlik başlıkları | CSP, HSTS, nosniff, `frame-ancestors 'none'`, `object-src 'none'` ✅ |
| XSS sink'leri | `dangerouslySetInnerHTML` 2 yerde, ikisi de güvenli (escape'li / sabit) |
| API anahtarı saklama | SHA-256 hash'li (`src/lib/apiKey.ts`) — token saklamada örnek alınmalı |
| Oturum çerezi | `httpOnly` + `SameSite=Lax` |
| Login brute-force | **E-posta** anahtarlı limit → XFF spoof'undan etkilenmiyor (bilinçli tasarım, koruyun) |
| Inbound e-posta | Gönderenin thread katılımcısı olması ayrıca doğrulanıyor + `timingSafeEqual` |

## 5. Backlog'a çevirirken (issue yazımı)

- **`sub_issue_write` yanıtı ebeveynin TÜM gövdesini geri döndürür.** 37 bağlantıda
  bu çok ciddi context tüketimi. Doğru sıra: **önce tüm issue'ları oluştur**
  (create yanıtları küçük), ID eşlemesini bir dosyaya yaz, **bağlantıları en sona
  bırak**. Ebeveyn gövdesi ne kadar uzunsa maliyet o kadar yüksek → kök/umbrella
  issue'ları kısa tutun.
- **Issue numaraları ardışık gelmiyor** (814, 816, 818… atlıyor). Gövdede "bkz #N"
  yazarken numarayı **önceden tahmin etmeyin**; oluşturduktan sonra düzeltin
  (veya düzeltme yorumu ekleyin).
- `issue_write` ile `labels` + `issue_fields` (org **Priority** alanı) **create
  anında** birlikte verilebilir → issue başına 1 çağrı tasarrufu.
  Eşleme: `P0→Urgent`, `P1→High`, `P2→Medium`, `P3→Low`.
- Label güncellemesi **tüm seti değiştirir** — mevcutları yeniden göndermeyi unutmayın.

## 6. Denetim öncesi hızlı kod taramaları

```bash
# Session/rol kontrolü olmayan route'lar
for f in $(find src/app/api -name route.ts); do
  grep -q "getServerSession\|authenticateApiKey" "$f" || echo "NO AUTH: $f"; done

# Allowlist-by-omission: rol zinciri var ama else-deny yok
grep -rn "role === 'MENTOR'" src/app/api --include=route.ts -A6 | grep -B2 "else if"

# Denetim kaydı olmayan ayrıcalıklı route'lar
for f in $(find src/app/api/admin -name route.ts); do
  grep -qE "logActivity|auditLog" "$f" || echo "UNAUDITED: $f"; done

# Token üretimi ve saklama
grep -rn "randomBytes\|createHmac\|Math.random" src/lib src/app/api --include=*.ts

# Fail-open fallback'ler
grep -rn "|| 'dev-\|if (!expected) return true" src/lib src/app/api

# Bağımlılık zafiyetleri
npm audit --json | node -e "…"   # şiddet + fixAvailable tablosu
```

## 7. Bu denetimde bulunamayan / bakılmayan alanlar

Bir sonraki turda buradan başlayın:

- **Yük / DoS davranışı** — `npm run test:stress` var ama güvenlik açısından
  koşulmadı.
- **SAML SSO akışı** — `mocksaml.com` ile uçtan uca test edilebilir
  (bkz. `agent-experience.md`, 2026-07-24 girdisi); bu turda kod okumasıyla yetinildi.
- **Google Calendar OAuth** — env'de dormant, test edilmedi.
- **AI uçları** (`/api/cv/[userId]/extract-ai`, `interview-prep`) — prompt injection
  yüzeyi hiç incelenmedi. Kullanıcı CV'si model'e giriyor; bu ayrı bir tehdit sınıfı.
- **`prisma db push --accept-data-loss`** deploy adımının veri kaybı riski.
- **Preview ortamının paylaşımlı DB'si** (issue #39) — çok kiracılı sızıntı senaryosu.

---

_Son güncelleme: 2026-07-28 · Bu playbook'u her denetimden sonra güncelleyin._
