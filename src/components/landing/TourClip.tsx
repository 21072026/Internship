'use client';

import { useEffect, useRef, useState } from 'react';

// The moving half of a product-tour screen (#1399): a short silent loop laid
// over the still, which stays underneath as its poster. Three rules keep it
// cheap and polite:
//   • Nothing is fetched until the frame is on screen (`preload="none"`, and
//     the sources are only attached then). A clip whose frame is display:none —
//     the other theme, or any phone — never intersects, so it never loads.
//   • A visitor who asked the OS for reduced motion keeps the still.
//   • It fades in only once it is actually playing, so a slow network shows
//     the still, never an empty box.

export function TourClip({ webm, mp4, className }: { webm: string; mp4: string; className: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [armed, setArmed] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setArmed(true);
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { threshold: 0.5 },
    );
    io.observe(video);
    return () => io.disconnect();
  }, []);

  // The sources arrive with `armed`; load() makes the element pick them up.
  useEffect(() => {
    const video = ref.current;
    if (armed && video) {
      video.load();
      video.play().catch(() => {});
    }
  }, [armed]);

  return (
    <video
      ref={ref}
      muted
      loop
      playsInline
      preload="none"
      aria-hidden="true"
      tabIndex={-1}
      onPlaying={() => setPlaying(true)}
      className={`${className} absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${playing ? 'opacity-100' : 'opacity-0'}`}
    >
      {armed && <source src={webm} type="video/webm" />}
      {armed && <source src={mp4} type="video/mp4" />}
    </video>
  );
}
