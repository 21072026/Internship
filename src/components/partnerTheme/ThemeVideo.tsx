'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';

// A theme's decorative video (#3535): muted, looping, inline — and paused for a
// visitor whose device asks for reduced motion. It always carries a pause /
// play button (WCAG 2.2.2: moving content that starts by itself and lasts more
// than five seconds can be stopped). The video itself is hidden from assistive
// technology; it says nothing the page does not.
export function ThemeVideo({
  src,
  className,
  labels,
  buttonClassName,
}: {
  src: string;
  className?: string;
  labels: { pause: string; play: string };
  buttonClassName?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!reduce.matches) v.play().then(() => setPlaying(true), () => setPlaying(false));
    const onChange = () => {
      if (reduce.matches) {
        v.pause();
        setPlaying(false);
      }
    };
    reduce.addEventListener('change', onChange);
    return () => reduce.removeEventListener('change', onChange);
  }, [src]);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) v.play().then(() => setPlaying(true), () => setPlaying(false));
    else {
      v.pause();
      setPlaying(false);
    }
  };

  return (
    <>
      <video ref={ref} src={src} className={className} muted loop playsInline preload="metadata" aria-hidden="true" data-testid="partner-theme-video" data-playing={playing ? 'true' : 'false'} />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? labels.pause : labels.play}
        aria-pressed={!playing}
        className={`absolute bottom-3 right-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${buttonClassName ?? ''}`}
        style={{ backgroundColor: 'rgba(0,0,0,0.6)', color: '#ffffff', outlineColor: '#ffffff' }}
        data-testid="partner-theme-video-toggle"
      >
        {playing ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
      </button>
    </>
  );
}
