// Inline SVG icons. Six icons — lightning (shock), play / pause
// (commentary toggle in the demo toolbar), GitHub mark, npm mark
// (placeholder until publish), LinkedIn mark. Inlined rather than pulled
// from a library to keep the bundle clean (`lucide-react` would add ~30 KB
// gz for icons we use once each); `currentColor` lets the surrounding
// button drive stroke/fill from text colour.
//
// Play/pause convention is media-player standard: while a stream is
// running the button shows the PAUSE icon (clicking it pauses); while
// paused the button shows the PLAY icon (clicking it plays). The icon
// always represents the next action — same idiom as YouTube, Spotify,
// browser media controls.

const ICON_SIZE = 16;

export function LightningIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={ICON_SIZE}
      height={ICON_SIZE}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M13 2 4 14h7l-1 8 10-12h-7l1-8h-1z" />
    </svg>
  );
}

// Play icon. Standard right-pointing triangle, vertically centred.
// Renders on the toolbar toggle when commentary is paused; clicking
// resumes the commentary stream.
export function PlayIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={ICON_SIZE}
      height={ICON_SIZE}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

// Pause icon. Two vertical bars. Renders on the toolbar toggle when
// commentary is running; clicking pauses the stream.
export function PauseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={ICON_SIZE}
      height={ICON_SIZE}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
    </svg>
  );
}

export function GithubIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={ICON_SIZE}
      height={ICON_SIZE}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

export function NpmIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={ICON_SIZE}
      height={ICON_SIZE}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" />
    </svg>
  );
}

export function LinkedInIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={ICON_SIZE}
      height={ICON_SIZE}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}
