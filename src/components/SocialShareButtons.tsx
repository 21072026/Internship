'use client';

import { useState } from 'react';
import { Share2, Check, Linkedin, Twitter } from 'lucide-react';
import { trackEvent } from '@/lib/analytics';

interface SocialShareButtonsProps {
  headline: string;
  targetPosition?: string | null;
  profileUrl?: string;
}

export function SocialShareButtons({ headline, targetPosition, profileUrl }: SocialShareButtonsProps) {
  const [copied, setCopied] = useState(false);

  const currentUrl = typeof window !== 'undefined' ? profileUrl || window.location.href : '';
  const shareText = `Check out ${headline}${targetPosition ? ` (${targetPosition})` : ''}'s profile on InternshipCRM!`;

  const shareLinkedIn = () => {
    trackEvent('profile_shared_linkedin', { headline });
    const url = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(currentUrl)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const shareTwitter = () => {
    trackEvent('profile_shared_twitter', { headline });
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(currentUrl)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const copyLink = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(currentUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div className="mt-6 pt-4 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-3">
      <span className="text-xs text-gray-500 font-medium flex items-center gap-1.5">
        <Share2 className="h-3.5 w-3.5 text-blue-600" />
        Profilini Paylaş:
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={shareLinkedIn}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors border border-blue-200/50"
        >
          <Linkedin className="h-3.5 w-3.5 fill-current" />
          <span>LinkedIn</span>
        </button>
        <button
          onClick={shareTwitter}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-50 text-sky-700 hover:bg-sky-100 transition-colors border border-sky-200/50"
        >
          <Twitter className="h-3.5 w-3.5 fill-current" />
          <span>X / Twitter</span>
        </button>
        <button
          onClick={copyLink}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : null}
          <span>{copied ? 'Kopyalandı!' : 'Bağlantı'}</span>
        </button>
      </div>
    </div>
  );
}
