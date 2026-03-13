import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "./theme-provider";

export const metadata: Metadata = {
  title: "CHOP — Sample-Based Music Generator",
  description: "Slice, sequence, generate.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{const t=localStorage.getItem("chop-theme");if(t)document.documentElement.className=t}catch(e){}`,
          }}
        />
      </head>
      <body
        className="min-h-screen antialiased"
        style={{
          fontFamily: "'IBM Plex Sans', sans-serif",
          ["--font-sans" as string]: "'IBM Plex Sans', sans-serif",
          ["--font-mono" as string]: "'IBM Plex Mono', monospace",
        }}
      >
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
