import './globals.css';

export const metadata = {
  title: 'Mosaic Wellness — Invoice Audit Intelligence',
  description: 'Deterministic invoice-audit system for Mosaic Wellness Accounts Payable',
};

// Runs before first paint so the correct palette is applied without a flash of
// the wrong theme. A stored choice wins; otherwise fall back to the OS setting.
// Kept dependency-free and wrapped in try/catch because localStorage throws in
// private-mode Safari and under some embedded webviews.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('mosaic-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
