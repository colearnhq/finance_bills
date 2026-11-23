import type { Metadata } from "next";
import { Overpass, Poppins } from "next/font/google";
import "./globals.css";

// Same font pair as colearn-finance: Poppins (headings, nav, buttons) and Overpass (body).
const poppins = Poppins({ variable: "--font-poppins", subsets: ["latin"], weight: ["400", "700"], display: "swap" });
const overpass = Overpass({ variable: "--font-overpass", subsets: ["latin"], weight: ["400", "700"], display: "swap" });

export const metadata: Metadata = {
  title: "AP Hub",
  description: "AI-powered accounts payable",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${poppins.variable} ${overpass.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
