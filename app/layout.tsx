import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Demo 0005 – Vercel', description: 'Static demo with OpenAI agent' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body style={{margin:0}}>{children}</body></html>);
}
