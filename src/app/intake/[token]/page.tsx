import { PublicForm } from "@/components/public-form";
export const metadata = {
  title: "Customer intake · Linkd",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  return <PublicForm token={(await params).token} kind="intake" />;
}
