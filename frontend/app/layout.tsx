import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Nigeria CEWS — Conflict Early Warning System',
  description: 'Nationwide Conflict Early Warning System covering all 36 Nigerian states and the FCT.',
  manifest: '/manifest.json',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-900 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
