import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import Link from "next/link";
import { Visit } from "@/components/Visit";
import "./globals.css";

const sans = Archivo({ subsets: ["latin"], variable: "--font-sans", axes: ["wdth"] });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "One Link",
  description: "Find the one thing to build that gets a founder to reply.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <header className="top">
          <Link href="/" className="wordmark">One Link</Link>
          <nav>
            <Link href="/">For candidates</Link>
            <Link href="/founders">For founders</Link>
            <Link href="/why">Why</Link>
          </nav>
        </header>
        <Visit />
        {children}
        <footer className="foot">
          <p>
            An independent concept by Ahdithan Uthayakumar. Not affiliated with or endorsed by a16z or speedrun.
            Role data comes from the public speedrun talent network API and refreshes daily.{" "}
            <a href="https://github.com/ahdithanu/one-link">The code is on GitHub.</a>
          </p>
        </footer>
      </body>
    </html>
  );
}
