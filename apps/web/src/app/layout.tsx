import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Factory on Rails", template: "%s · Factory on Rails" },
  description: "Queue coding tasks against your GitHub repos. Each runs in its own Railway sandbox and comes back as a pull request.",
  icons: {
    icon: { url: "/logo.svg", type: "image/svg+xml", sizes: "any" },
    apple: { url: "/apple-icon.png", type: "image/png", sizes: "180x180" },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-svh">
        <ThemeProvider>
          <TooltipProvider>
            {children}
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
