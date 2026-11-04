import type { Metadata } from "next";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";

import { WalletAppProvider } from "@/components/wallet-kit";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "DONADS — Autonomous work for Monad",
  description:
    "A precise, approval-gated agent workspace for research, campaigns, workflows, and Monad Testnet operations.",
  icons: {
    icon: "/brand/donads-mascot-tile.png",
    apple: "/brand/donads-mascot-tile.png",
  },
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${instrumentSerif.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <WalletAppProvider>{children}</WalletAppProvider>
      </body>
    </html>
  );
}
