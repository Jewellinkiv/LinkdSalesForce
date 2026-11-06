export const inboundBrands = [
  "jewellink",
  "linkd",
  "jewelhire",
  "countretail",
  "unknown",
] as const;
export type InboundBrand = (typeof inboundBrands)[number];
export const brandNames: Record<InboundBrand, string> = {
  jewellink: "JewelLink",
  linkd: "Linkd",
  jewelhire: "JewelHire",
  countretail: "CountRetail",
  unknown: "Unassigned",
};
export type InboundRecord = {
  id: string;
  kind: "form" | "booking";
  provider: string;
  brand: InboundBrand;
  title: string;
  name: string;
  email: string;
  phone: string;
  company_name: string;
  company_id: string | null;
  retailer_id: string | null;
  prospect_id: string | null;
  linked_company_id: string | null;
  linked_company_name: string | null;
  retailer_name: string | null;
  owner_id: string;
  owner_name: string;
  match_status: string;
  status: string;
  review_status: string;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string;
  notes: string;
  outcome: string;
  details: {
    pageUrl?: string;
    message?: string;
    fields?: Record<string, string>;
    tracking?: Record<string, string | null>;
    location?: string;
    joinUrl?: string;
    host?: string;
    cancelUrl?: string;
    rescheduleUrl?: string;
    oldInvitee?: string | null;
    newInvitee?: string | null;
    questions?: { question: string; answer: string }[];
  };
  created_at: string;
  updated_at: string;
  version: number;
};
export type InboundRouting = {
  brand: InboundBrand;
  owner_id: string | null;
  notify_user_ids: string[];
  booking_url: string;
  event_type_uris: string[];
  version: number;
  configured: boolean;
  last_received: string | null;
  received: number;
};
export type InboundData = {
  records: InboundRecord[];
  total: number;
  stats: {
    forms: number;
    upcoming: number;
    needs_review: number;
    unlinked: number;
  };
  routing: InboundRouting[];
  calendly: {
    verifiedEvents: number;
    lastReceived: string | null;
    configured: boolean;
  };
  accounts: { id: string; name: string; city: string }[];
};
