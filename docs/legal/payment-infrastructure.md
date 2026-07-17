# Ödeme altyapısı kararı (#552)

## Karar — iki fazlı
Erken karmaşıklık eklemeden gelir doğrulaması için:

### Faz 1 — Manuel faturalama (kod gerekmez) ✅ şimdi
- Entitlement (`hasFeature` / premium Setting) **elle** açılır (admin).
- Fatura bcsit GmbH tarafından elle kesilir (bkz. [legal-tax-framework.md](legal-tax-framework.md)).
- Uygun çünkü: ilk müşteri sayısı az; amaç ödeme akışını değil **değeri** doğrulamak.
- Gereken: yok (mevcut entitlement katmanı yeterli).

### Faz 2 — Stripe Billing (ölçeklenince)
- **Sağlayıcı: Stripe** (abonelik/Billing + Customer Portal + Tax). Gerekçe: en olgun
  SaaS abonelik altyapısı, güçlü webhook, AB KDV/`Stripe Tax` desteği, düşük entegrasyon
  maliyeti.
- **Akış:** Checkout/Customer Portal ile abonelik → **webhook** (`checkout.session.completed`,
  `customer.subscription.updated/deleted`) → entitlement'ı otomatik senkronla
  (premium Setting / `hasFeature` kaydı). İmza doğrulaması (`Stripe-Signature`) zorunlu.
- **Entitlement eşlemesi:** Stripe `price`/`product` → tenant plan (Free/Pro/Enterprise);
  webhook geldiğinde ilgili tenant'ın entitlement'ı güncellenir. Multi-tenancy (#543)
  sonrası tenant-seviyesine bağlanır.
- **Uygulama ayrı bir issue** olacak (Faz 3 multi-tenancy + plan limitleri #547 ile
  birlikte anlamlı).

## Neden şimdi Stripe entegre etmiyoruz
- Gelir/pilot doğrulanmadan webhook+abonelik+vergi entegrasyonu bakım yükü getirir.
- Faz 1 manuel akış ilk gelirleri toplamak için yeterli; Stripe, tekrar eden müşteri
  ve otomatik yenileme ihtiyacı doğunca devreye alınır.

## Aksiyon listesi
- [ ] Faz 1: premium açılışını elle yönet (mevcut admin toggle).
- [ ] Faz 2 tetikleyici: tekrar eden ödeme / birden çok müşteri olunca Stripe entegrasyon
      issue'su aç (Checkout + webhook → entitlement + Stripe Tax).
