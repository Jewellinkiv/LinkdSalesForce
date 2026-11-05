import { ContactForm } from "@/components/contact-form";
export const metadata = {
  title: "Email preferences · Linkd",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  return <ContactForm token={(await params).token} />;
}
