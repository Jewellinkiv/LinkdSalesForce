import { ContactForm } from "@/components/contact-form";
export const metadata = {
  title: "Contact Linkd",
  robots: { index: false, follow: false },
};
export default function Page() {
  return <ContactForm />;
}
