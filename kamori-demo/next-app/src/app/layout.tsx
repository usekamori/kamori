import type { ReactNode } from "react";
import { KamoriProvider } from "../components/KamoriProvider";

export const metadata = {
  title: "Kamori Demo",
  description: "Multi-service observability demo powered by Kamori",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: "800px", margin: "0 auto" }}>
        {/*
          KamoriProvider activates browser-side logging for all pages:
          - captures unhandled JS errors via window.onerror
          - captures unhandled promise rejections
          - logs page_view on mount
          See src/components/KamoriProvider.tsx for the full pattern.
        */}
        <KamoriProvider>
          {children}
        </KamoriProvider>
      </body>
    </html>
  );
}
