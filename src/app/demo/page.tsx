'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  GraduationCap,
  Users,
  UserCheck,
  Building2,
  Kanban,
  MessageSquare,
  ArrowRight,
  Sparkles,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import { trackEvent } from '@/lib/analytics';

type RoleTab = 'admin' | 'mentor' | 'mentee' | 'company';

export default function DemoPage() {
  const [activeRole, setActiveRole] = useState<RoleTab>('admin');
  const [interactionLogged, setInteractionLogged] = useState(false);
  const [shortlisted, setShortlisted] = useState<Record<string, boolean>>({
    c1: true,
    c2: false,
    c3: false,
  });

  useEffect(() => {
    trackEvent('demo_started', { initialRole: 'admin' });
  }, []);

  const handleRoleChange = (role: RoleTab) => {
    setActiveRole(role);
    trackEvent('demo_role_switched', { role });
  };

  const sampleMentees = [
    {
      id: 'm1',
      name: 'Zeynep Yılmaz',
      university: 'Middle East Technical University',
      dept: 'Computer Engineering',
      stage: 'STAJ_DEVAM_450',
      stageLabel: 'Staj Devam Ediyor',
      mentor: 'Ahmet Demir (Sr. Tech Lead)',
      company: 'TechCorp A.Ş.',
      skills: ['React', 'TypeScript', 'Node.js'],
      avatarBg: 'bg-emerald-500',
    },
    {
      id: 'm2',
      name: 'Caner Şahin',
      university: 'Istanbul Technical University',
      dept: 'Software Engineering',
      stage: 'GORUSME_250',
      stageLabel: 'Görüşme Bekliyor',
      mentor: 'Elif Kaya (Staff Engineer)',
      company: 'DataFlow Inc.',
      skills: ['Python', 'FastAPI', 'PostgreSQL'],
      avatarBg: 'bg-blue-500',
    },
    {
      id: 'm3',
      name: 'Ece Aydın',
      university: 'Bilkent University',
      dept: 'Industrial Engineering',
      stage: 'ISE_ALINDI_660',
      stageLabel: 'İşe Alındı 🎉',
      mentor: 'Murat Yıldız (Product Mgr)',
      company: 'FintechX Ltd.',
      skills: ['Product Analytics', 'SQL', 'Figma'],
      avatarBg: 'bg-purple-500',
    },
  ];

  const sampleInteractions = [
    { id: 1, type: 'Meeting', title: 'Haftalık 1:1 Staj Değerlendirmesi', date: 'Dün, 14:00', note: 'Menti Next.js optimizasyonu konusundaki görevini başarıyla tamamladı.' },
    { id: 2, type: 'WhatsApp', title: 'Kod İnceleme Geri Bildirimi', date: '2 gün önce', note: 'PR #42 incelemesi yapıldı ve refactoring tavsiyeleri iletildi.' },
  ];

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans selection:bg-blue-500 selection:text-white">
      {/* Demo Banner */}
      <div className="bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 py-2.5 text-center text-xs sm:text-sm font-medium text-white shadow-md flex items-center justify-center gap-2">
        <Sparkles className="h-4 w-4 animate-pulse" />
        <span>İnteraktif Canlı Demo Modu — Tüm rolleri gerçekçi verilerle deneyimleyin!</span>
        <Link
          href="/auth/register"
          className="ml-2 bg-white text-blue-700 hover:bg-blue-50 px-3 py-1 rounded-full text-xs font-semibold transition-all shadow-sm"
        >
          Ücretsiz Başla
        </Link>
      </div>

      {/* Navigation Header */}
      <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-md sticky top-0 z-30 px-4 sm:px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="p-2 bg-blue-600/20 text-blue-400 rounded-xl group-hover:bg-blue-600 group-hover:text-white transition-all">
              <GraduationCap className="h-6 w-6" />
            </div>
            <span className="font-bold text-lg text-white">InternshipCRM</span>
          </Link>
          <span className="hidden sm:inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            Live Sandbox
          </span>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/auth/signin"
            className="text-slate-300 hover:text-white text-sm font-medium transition-colors px-3 py-2"
          >
            Giriş Yap
          </Link>
          <Link
            href="/auth/register"
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-all shadow-lg shadow-blue-600/25 flex items-center gap-2"
          >
            <span>Kayıt Ol</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-8 space-y-8">
        {/* Header Title */}
        <div className="text-center max-w-3xl mx-auto space-y-3">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
            Uygulamayı <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-400">Canlı Görün</span>
          </h1>
          <p className="text-slate-400 text-sm sm:text-base">
            Farklı kullanıcı rollerinin ekranlarına göz atın, mentörlük sürecini ve aday akışını canlı simüle edin.
          </p>
        </div>

        {/* Role Selector Tabs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4 p-1.5 bg-slate-950/60 rounded-2xl border border-slate-800">
          <button
            onClick={() => handleRoleChange('admin')}
            className={`flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-medium transition-all ${
              activeRole === 'admin'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30 font-semibold'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Users className="h-4 w-4" />
            <span>Admin Paneli</span>
          </button>
          <button
            onClick={() => handleRoleChange('mentor')}
            className={`flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-medium transition-all ${
              activeRole === 'mentor'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30 font-semibold'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <UserCheck className="h-4 w-4" />
            <span>Mentör Portalı</span>
          </button>
          <button
            onClick={() => handleRoleChange('mentee')}
            className={`flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-medium transition-all ${
              activeRole === 'mentee'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30 font-semibold'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <GraduationCap className="h-4 w-4" />
            <span>Menti Portalı</span>
          </button>
          <button
            onClick={() => handleRoleChange('company')}
            className={`flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-medium transition-all ${
              activeRole === 'company'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30 font-semibold'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Building2 className="h-4 w-4" />
            <span>Şirket Paneli</span>
          </button>
        </div>

        {/* Dashboard Preview Area */}
        <div className="bg-slate-950/70 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-6">
          {/* Admin Role Screen */}
          {activeRole === 'admin' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
                <div>
                  <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <Users className="h-5 w-5 text-blue-400" />
                    <span>Yönetici Genel Bakış Paneli</span>
                  </h2>
                  <p className="text-slate-400 text-xs sm:text-sm">Tüm adaylar, mentör eşleşmeleri ve dönüşüm hunisi</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs bg-slate-800 text-slate-300 px-3 py-1.5 rounded-lg border border-slate-700">
                    Aktif Menti: 142
                  </span>
                  <span className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-3 py-1.5 rounded-lg">
                    İşe Alım Oranı: %68
                  </span>
                </div>
              </div>

              {/* Stats Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
                  <div className="text-slate-400 text-xs">Toplam Aday</div>
                  <div className="text-2xl font-bold text-white mt-1">184</div>
                  <div className="text-xs text-emerald-400 mt-1">↑ %12 geçen aya göre</div>
                </div>
                <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
                  <div className="text-slate-400 text-xs">Aktif Mentörler</div>
                  <div className="text-2xl font-bold text-white mt-1">32</div>
                  <div className="text-xs text-slate-400 mt-1">Kapasite: %85 dolu</div>
                </div>
                <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
                  <div className="text-slate-400 text-xs">Devam Eden Staj</div>
                  <div className="text-2xl font-bold text-blue-400 mt-1">45</div>
                  <div className="text-xs text-blue-400/80 mt-1">14 Farklı Şirkette</div>
                </div>
                <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
                  <div className="text-slate-400 text-xs">İşe Yerleşenler</div>
                  <div className="text-2xl font-bold text-emerald-400 mt-1">28</div>
                  <div className="text-xs text-emerald-400/80 mt-1">Bu dönem tamamlanan</div>
                </div>
              </div>

              {/* Kanban Preview */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                  <Kanban className="h-4 w-4 text-blue-400" />
                  <span>Staj ve İşe Alım Hunisi (Kanban Görünümü)</span>
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-2xl space-y-3">
                    <div className="flex items-center justify-between text-xs font-medium text-slate-400 border-b border-slate-800 pb-2">
                      <span>1. Başvuru & Görüşme (250)</span>
                      <span className="bg-slate-800 px-2 py-0.5 rounded text-slate-300">12 Aday</span>
                    </div>
                    <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700/50 space-y-2">
                      <div className="font-medium text-sm text-slate-200">Caner Şahin</div>
                      <div className="text-xs text-slate-400">İTÜ • Yazılım Mühendisliği</div>
                      <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
                        <span>Mentör: Elif K.</span>
                        <span className="text-blue-400">Mülakat Bekliyor</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-2xl space-y-3">
                    <div className="flex items-center justify-between text-xs font-medium text-blue-400 border-b border-slate-800 pb-2">
                      <span>2. Staj Devam Ediyor (450)</span>
                      <span className="bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded text-blue-400">18 Aday</span>
                    </div>
                    <div className="bg-blue-950/40 p-3 rounded-xl border border-blue-800/40 space-y-2">
                      <div className="font-medium text-sm text-white">Zeynep Yılmaz</div>
                      <div className="text-xs text-slate-400">ODTÜ • Bilgisayar Müh.</div>
                      <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
                        <span>TechCorp A.Ş.</span>
                        <span className="text-emerald-400">4. Hafta</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-2xl space-y-3">
                    <div className="flex items-center justify-between text-xs font-medium text-emerald-400 border-b border-slate-800 pb-2">
                      <span>3. İşe Alındı / Buldu (660)</span>
                      <span className="bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded text-emerald-400">28 Aday</span>
                    </div>
                    <div className="bg-emerald-950/30 p-3 rounded-xl border border-emerald-800/40 space-y-2">
                      <div className="font-medium text-sm text-emerald-200">Ece Aydın</div>
                      <div className="text-xs text-slate-400">Bilkent • Endüstri Müh.</div>
                      <div className="flex items-center justify-between text-[11px] text-emerald-400 pt-1">
                        <span>FintechX Ltd.</span>
                        <span>Tam Zamanlı 🎉</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Mentor Role Screen */}
          {activeRole === 'mentor' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div>
                  <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <UserCheck className="h-5 w-5 text-emerald-400" />
                    <span>Mentör Portalı Simülatörü</span>
                  </h2>
                  <p className="text-slate-400 text-xs sm:text-sm">Mentilerinizi takip edin ve etkileşim kaydedin</p>
                </div>
                <span className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-3 py-1.5 rounded-lg">
                  Benim Mentilerim: 4 / 5
                </span>
              </div>

              {/* Sample Interaction Interactive Log */}
              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-emerald-400" />
                    <span>Hızlı Etkileşim Kaydı (Simülatör)</span>
                  </h3>
                  {interactionLogged && (
                    <span className="text-xs text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Etkileşim Kaydedildi!
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <button
                    onClick={() => setInteractionLogged(true)}
                    className="p-3 bg-slate-800 hover:bg-slate-700/80 rounded-xl border border-slate-700 text-left transition-all space-y-1"
                  >
                    <div className="font-semibold text-slate-200 flex items-center justify-between">
                      <span>+ 1:1 Görüşme Kaydet</span>
                      <Clock className="h-3.5 w-3.5 text-blue-400" />
                    </div>
                    <div className="text-slate-400">Zeynep Yılmaz ile 45 dk haftalık kod değerlendirmesi</div>
                  </button>

                  <button
                    onClick={() => setInteractionLogged(true)}
                    className="p-3 bg-slate-800 hover:bg-slate-700/80 rounded-xl border border-slate-700 text-left transition-all space-y-1"
                  >
                    <div className="font-semibold text-slate-200 flex items-center justify-between">
                      <span>+ WhatsApp / Mesaj Notu</span>
                      <MessageSquare className="h-3.5 w-3.5 text-emerald-400" />
                    </div>
                    <div className="text-slate-400">PR #42 geri bildirimi iletildi</div>
                  </button>
                </div>

                <div className="border-t border-slate-800 pt-3 space-y-2">
                  <div className="text-xs font-semibold text-slate-400">Son Etkileşim Geçmişi</div>
                  {sampleInteractions.map((item) => (
                    <div key={item.id} className="text-xs bg-slate-950 p-2.5 rounded-lg flex items-start justify-between">
                      <div>
                        <span className="font-medium text-slate-200">{item.title}</span>
                        <p className="text-slate-400 mt-0.5">{item.note}</p>
                      </div>
                      <span className="text-[10px] text-slate-500 whitespace-nowrap ml-2">{item.date}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Mentee Role Screen */}
          {activeRole === 'mentee' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div>
                  <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <GraduationCap className="h-5 w-5 text-purple-400" />
                    <span>Menti Portalı & Yol Haritası</span>
                  </h2>
                  <p className="text-slate-400 text-xs sm:text-sm">Mentiniz gelişim durumunu ve staj aşamasını görür</p>
                </div>
                <span className="text-xs bg-purple-500/10 text-purple-400 border border-purple-500/20 px-3 py-1.5 rounded-lg">
                  Profil Doluluk: %95
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-4">
                  <h3 className="text-sm font-semibold text-slate-200">Atanmış Mentör & Şirket</h3>
                  <div className="space-y-3 text-xs">
                    <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center font-bold text-white text-sm">
                        AD
                      </div>
                      <div>
                        <div className="font-semibold text-slate-200">Ahmet Demir</div>
                        <div className="text-slate-400">Senior Tech Lead • TechCorp A.Ş.</div>
                      </div>
                    </div>

                    <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
                      <div className="text-slate-400">Hedef Pozisyon</div>
                      <div className="font-semibold text-slate-200 text-sm">Full-Stack Software Engineer</div>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-4">
                  <h3 className="text-sm font-semibold text-slate-200">Yetenek Seviyeleri</h3>
                  <div className="space-y-2 text-xs">
                    <div>
                      <div className="flex justify-between text-slate-400 mb-1">
                        <span>React / Next.js</span>
                        <span>Seviye 4/5</span>
                      </div>
                      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 w-[80%]"></div>
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between text-slate-400 mb-1">
                        <span>TypeScript</span>
                        <span>Seviye 4/5</span>
                      </div>
                      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-indigo-500 w-[80%]"></div>
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between text-slate-400 mb-1">
                        <span>Node.js / Express</span>
                        <span>Seviye 3/5</span>
                      </div>
                      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 w-[60%]"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Company Role Screen */}
          {activeRole === 'company' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div>
                  <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <Building2 className="h-5 w-5 text-amber-400" />
                    <span>Şirket Yetenek Havuzu Paneli</span>
                  </h2>
                  <p className="text-slate-400 text-xs sm:text-sm">Adayları inceleyin, favorilerinize ekleyin</p>
                </div>
                <span className="text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20 px-3 py-1.5 rounded-lg">
                  TechCorp A.Ş.
                </span>
              </div>

              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-200">Öne Çıkan Aday Havuzu</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {sampleMentees.map((m) => (
                    <div key={m.id} className="bg-slate-900 border border-slate-800 p-4 rounded-2xl space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className={`w-7 h-7 rounded-full ${m.avatarBg} text-white font-bold flex items-center justify-center text-xs`}>
                            {m.name[0]}
                          </div>
                          <div className="font-semibold text-sm text-slate-200">{m.name}</div>
                        </div>
                        <button
                          onClick={() =>
                            setShortlisted((prev) => ({ ...prev, [m.id]: !prev[m.id] }))
                          }
                          className={`text-xs px-2 py-1 rounded-md border transition-all ${
                            shortlisted[m.id]
                              ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                              : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
                          }`}
                        >
                          {shortlisted[m.id] ? '★ İlgilenildi' : '☆ Kısa Liste'}
                        </button>
                      </div>

                      <div className="text-xs text-slate-400">{m.university}</div>

                      <div className="flex flex-wrap gap-1">
                        {m.skills.map((s) => (
                          <span key={s} className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded">
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* CTA Footer */}
        <div className="bg-gradient-to-r from-blue-900/60 to-indigo-900/60 border border-blue-700/40 rounded-3xl p-8 text-center space-y-4">
          <h2 className="text-2xl font-bold text-white">Kendi Kurumunuz İçin Ücretsiz Başlatın</h2>
          <p className="text-slate-300 max-w-xl mx-auto text-sm">
            Mentörlük ve stajyer süreçlerinizi Excel karmaşasından kurtarın. Ücretsiz plan ile 10 mentiye kadar hemen kullanmaya başlayın.
          </p>
          <div className="pt-2 flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/auth/register"
              className="bg-blue-600 hover:bg-blue-500 text-white font-semibold px-8 py-3.5 rounded-xl shadow-lg transition-all text-sm inline-flex items-center justify-center gap-2"
            >
              <span>Hemen Kaydolun</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
