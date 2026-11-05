import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Linkd Sales Force",
  description:
    "The connected workspace for sales, communication, and customer onboarding.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
