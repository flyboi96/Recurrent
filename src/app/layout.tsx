import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Recurrent", description: "Professional proficiency, made recurrent.", manifest: "/manifest.webmanifest", appleWebApp: { capable: true, statusBarStyle: "default", title: "Recurrent" } };
export const viewport: Viewport = { themeColor: "#092b3b", width: "device-width", initialScale: 1, viewportFit: "cover" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
