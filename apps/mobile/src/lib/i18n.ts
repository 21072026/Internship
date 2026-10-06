import { getLocales } from 'expo-localization';

// The app's own strings, EN/TR/DE like the web (#2775). Kept here rather than
// imported from src/i18n/dictionaries.ts: that file is the web's 18k-line
// dictionary and the app needs a few dozen strings. Key parity is enforced by
// the type — `tr` and `de` are `Strings`, so a missing key does not compile.

const en = {
  pickTitle: 'Which product do you use?',
  pickHint: 'You can switch later from the More tab.',
  email: 'E-mail',
  password: 'Password',
  totp: 'Authenticator or recovery code',
  remember: 'Keep me signed in on this device',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  forgot: 'Forgot password?',
  otherProduct: 'Use another product',
  errors: {
    TWO_FACTOR_REQUIRED: 'Enter the code from your authenticator app.',
    BAD_CODE: 'That code did not work. Try again.',
    PENDING_APPROVAL: 'Your account is waiting for approval.',
    EMAIL_NOT_VERIFIED: 'Please confirm your e-mail address first — check your inbox.',
    SSO_REQUIRED: 'Your organisation signs in with single sign-on. Use the web sign-in for now.',
    SERVICE_UNAVAILABLE: 'The service is busy. Please try again shortly.',
    WRONG_WORLD: 'This account does not belong to {product}.',
    LOCKED: 'Too many attempts. Please try again later.',
    DEACTIVATED: 'This account has been deactivated.',
    INVALID: 'Sign-in failed. Check your e-mail and password.',
    NETWORK: 'No connection. Check your internet and try again.',
  },
  tabs: { home: 'Home', messages: 'Messages', todos: 'To-dos', more: 'More' },
  hello: 'Hello, {name}',
  homeHint: 'Your messages, to-dos and notifications are one tap away.',
  notifications: 'Notifications',
  calendar: 'Calendar',
  profile: 'Profile',
  account: 'Account settings',
  openOnWeb: 'Everything else',
  signedInAs: 'Signed in as {email}',
  switchProduct: 'Switch product',
  signOut: 'Sign out',
  deleteAccount: 'Delete account',
  loading: 'Loading…',
  retry: 'Try again',
  offline: 'This page could not be loaded.',
};

export type Strings = typeof en;

const tr: Strings = {
  pickTitle: 'Hangi ürünü kullanıyorsun?',
  pickHint: 'Daha sonra Diğer sekmesinden değiştirebilirsin.',
  email: 'E-posta',
  password: 'Parola',
  totp: 'Doğrulama uygulaması veya kurtarma kodu',
  remember: 'Bu cihazda oturumum açık kalsın',
  signIn: 'Giriş yap',
  signingIn: 'Giriş yapılıyor…',
  forgot: 'Parolamı unuttum',
  otherProduct: 'Başka bir ürün kullan',
  errors: {
    TWO_FACTOR_REQUIRED: 'Doğrulama uygulamandaki kodu gir.',
    BAD_CODE: 'Kod geçersiz. Tekrar dene.',
    PENDING_APPROVAL: 'Hesabın onay bekliyor.',
    EMAIL_NOT_VERIFIED: 'Önce e-posta adresini doğrula — gelen kutunu kontrol et.',
    SSO_REQUIRED: 'Kurumun tek oturum açma (SSO) kullanıyor. Şimdilik web girişini kullan.',
    SERVICE_UNAVAILABLE: 'Hizmet şu an yoğun. Birazdan tekrar dene.',
    WRONG_WORLD: 'Bu hesap {product} hesabı değil.',
    LOCKED: 'Çok fazla deneme. Daha sonra tekrar dene.',
    DEACTIVATED: 'Bu hesap devre dışı bırakılmış.',
    INVALID: 'Giriş başarısız. E-posta ve parolanı kontrol et.',
    NETWORK: 'Bağlantı yok. İnternetini kontrol edip tekrar dene.',
  },
  tabs: { home: 'Ana sayfa', messages: 'Mesajlar', todos: 'Yapılacaklar', more: 'Diğer' },
  hello: 'Merhaba, {name}',
  homeHint: 'Mesajların, yapılacakların ve bildirimlerin bir dokunuş uzağında.',
  notifications: 'Bildirimler',
  calendar: 'Takvim',
  profile: 'Profil',
  account: 'Hesap ayarları',
  openOnWeb: 'Diğer her şey',
  signedInAs: '{email} olarak giriş yapıldı',
  switchProduct: 'Ürün değiştir',
  signOut: 'Çıkış yap',
  deleteAccount: 'Hesabı sil',
  loading: 'Yükleniyor…',
  retry: 'Tekrar dene',
  offline: 'Bu sayfa yüklenemedi.',
};

const de: Strings = {
  pickTitle: 'Welches Produkt nutzen Sie?',
  pickHint: 'Sie können das später unter „Mehr“ ändern.',
  email: 'E-Mail',
  password: 'Passwort',
  totp: 'Authenticator- oder Wiederherstellungscode',
  remember: 'Auf diesem Gerät angemeldet bleiben',
  signIn: 'Anmelden',
  signingIn: 'Anmeldung…',
  forgot: 'Passwort vergessen?',
  otherProduct: 'Anderes Produkt nutzen',
  errors: {
    TWO_FACTOR_REQUIRED: 'Geben Sie den Code aus Ihrer Authenticator-App ein.',
    BAD_CODE: 'Der Code war ungültig. Bitte erneut versuchen.',
    PENDING_APPROVAL: 'Ihr Konto wartet auf Freigabe.',
    EMAIL_NOT_VERIFIED: 'Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse – sehen Sie in Ihr Postfach.',
    SSO_REQUIRED: 'Ihre Organisation meldet sich per Single Sign-on an. Nutzen Sie vorerst die Web-Anmeldung.',
    SERVICE_UNAVAILABLE: 'Der Dienst ist ausgelastet. Bitte versuchen Sie es gleich erneut.',
    WRONG_WORLD: 'Dieses Konto gehört nicht zu {product}.',
    LOCKED: 'Zu viele Versuche. Bitte später erneut versuchen.',
    DEACTIVATED: 'Dieses Konto wurde deaktiviert.',
    INVALID: 'Anmeldung fehlgeschlagen. Prüfen Sie E-Mail und Passwort.',
    NETWORK: 'Keine Verbindung. Prüfen Sie Ihr Internet und versuchen Sie es erneut.',
  },
  tabs: { home: 'Start', messages: 'Nachrichten', todos: 'Aufgaben', more: 'Mehr' },
  hello: 'Hallo, {name}',
  homeHint: 'Nachrichten, Aufgaben und Benachrichtigungen sind einen Tipp entfernt.',
  notifications: 'Benachrichtigungen',
  calendar: 'Kalender',
  profile: 'Profil',
  account: 'Kontoeinstellungen',
  openOnWeb: 'Alles andere',
  signedInAs: 'Angemeldet als {email}',
  switchProduct: 'Produkt wechseln',
  signOut: 'Abmelden',
  deleteAccount: 'Konto löschen',
  loading: 'Wird geladen…',
  retry: 'Erneut versuchen',
  offline: 'Diese Seite konnte nicht geladen werden.',
};

const DICTS: Record<string, Strings> = { en, tr, de };

export type Locale = 'en' | 'tr' | 'de';

export function deviceLocale(): Locale {
  const code = getLocales()[0]?.languageCode ?? 'en';
  return code === 'tr' || code === 'de' ? code : 'en';
}

export function strings(locale: Locale = deviceLocale()): Strings {
  return DICTS[locale] ?? en;
}
