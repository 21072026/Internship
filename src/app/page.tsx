import Link from 'next/link';
import { GraduationCap, Users, Building2, ArrowRight, CheckCircle } from 'lucide-react';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { roleHome } from '@/lib/roleHome';

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  if (session) redirect(roleHome(session.user.role));

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-2">
              <GraduationCap className="h-8 w-8 text-blue-600" />
              <span className="text-xl font-bold text-gray-900">InternshipCRM</span>
            </div>
            <div className="flex items-center gap-4">
              <Link
                href="/auth/signin"
                className="text-gray-600 hover:text-gray-900 font-medium transition-colors"
              >
                Sign In
              </Link>
              <Link
                href="/auth/register"
                className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors"
              >
                Register
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="py-24 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-blue-100 text-blue-700 px-4 py-2 rounded-full text-sm font-medium mb-8">
            <CheckCircle className="h-4 w-4" />
            Mentor-Mentee CRM & Internship Management
          </div>
          <h1 className="text-5xl font-bold text-gray-900 mb-6 leading-tight">
            Connect Talent with{' '}
            <span className="text-blue-600">Opportunity</span>
          </h1>
          <p className="text-xl text-gray-600 mb-10 max-w-2xl mx-auto">
            A comprehensive platform for managing mentor-mentee relationships, tracking internships,
            and connecting students with partner companies.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/auth/signin"
              className="inline-flex items-center gap-2 bg-blue-600 text-white px-8 py-4 rounded-xl font-semibold hover:bg-blue-700 transition-colors text-lg"
            >
              Get Started <ArrowRight className="h-5 w-5" />
            </Link>
            <Link
              href="/auth/register"
              className="inline-flex items-center gap-2 border-2 border-gray-300 text-gray-700 px-8 py-4 rounded-xl font-semibold hover:border-blue-400 hover:text-blue-600 transition-colors text-lg"
            >
              Register with Invite
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-16 px-4 bg-white">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-3xl font-bold text-center text-gray-900 mb-12">
            Everything You Need
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="p-8 rounded-2xl border border-gray-100 hover:border-blue-200 hover:shadow-lg transition-all">
              <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center mb-4">
                <Users className="h-6 w-6 text-blue-600" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-3">Mentor Management</h3>
              <p className="text-gray-600">
                Assign mentors to mentees, track interaction logs, and receive automated reminders
                for inactive relationships.
              </p>
            </div>

            <div className="p-8 rounded-2xl border border-gray-100 hover:border-blue-200 hover:shadow-lg transition-all">
              <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center mb-4">
                <Building2 className="h-6 w-6 text-green-600" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-3">Company Partnerships</h3>
              <p className="text-gray-600">
                Manage partner companies, track their internship needs by position and period,
                and match candidates accordingly.
              </p>
            </div>

            <div className="p-8 rounded-2xl border border-gray-100 hover:border-blue-200 hover:shadow-lg transition-all">
              <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center mb-4">
                <GraduationCap className="h-6 w-6 text-purple-600" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-3">Candidate Tracking</h3>
              <p className="text-gray-600">
                Filter candidates by skills and graduation year, view CVs, and track their
                mentorship and internship progress.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Roles */}
      <section className="py-16 px-4">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold text-center text-gray-900 mb-12">Three Roles, One Platform</h2>
          <div className="space-y-6">
            {[
              {
                role: 'Admin',
                description:
                  'Full control over the platform — invite users, manage companies, assign mentorships, and run analytics.',
              },
              {
                role: 'Mentor',
                description:
                  'View assigned mentees, log interaction history (meetings, feedback, emails), and track their progress.',
              },
              {
                role: 'Mentee',
                description:
                  'Complete your profile, view your assigned mentor and company, and track your internship journey.',
              },
            ].map(({ role, description }) => {
              const styles =
                role === 'Admin'
                  ? {
                      wrap: 'bg-red-50 border-red-100',
                      icon: 'bg-red-100',
                      initial: 'text-red-700',
                      title: 'text-red-900',
                      desc: 'text-red-700',
                    }
                  : role === 'Mentor'
                  ? {
                      wrap: 'bg-blue-50 border-blue-100',
                      icon: 'bg-blue-100',
                      initial: 'text-blue-700',
                      title: 'text-blue-900',
                      desc: 'text-blue-700',
                    }
                  : {
                      wrap: 'bg-green-50 border-green-100',
                      icon: 'bg-green-100',
                      initial: 'text-green-700',
                      title: 'text-green-900',
                      desc: 'text-green-700',
                    };
              return (
                <div key={role} className={`flex items-start gap-4 p-6 rounded-xl border ${styles.wrap}`}>
                  <div
                    className={`w-10 h-10 rounded-lg ${styles.icon} flex items-center justify-center flex-shrink-0`}
                  >
                    <span className={`${styles.initial} font-bold text-sm`}>{role[0]}</span>
                  </div>
                  <div>
                    <h3 className={`font-semibold ${styles.title} mb-1`}>{role}</h3>
                    <p className={`${styles.desc} text-sm`}>{description}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white py-8 px-4">
        <div className="max-w-7xl mx-auto text-center text-gray-500 text-sm">
          <p>© {new Date().getFullYear()} InternshipCRM. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
