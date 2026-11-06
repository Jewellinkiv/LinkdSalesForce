export const retailerFields = [
  "name",
  "contactName",
  "firstName",
  "lastName",
  "ownerName",
  "email",
  "phone",
  "address",
  "address2",
  "city",
  "state",
  "postal",
  "country",
  "website",
  "category",
  "notes",
] as const;
export type RetailerField = (typeof retailerFields)[number];
export type RetailerMapping = Partial<Record<RetailerField, number>>;
export type RetailerRow = {
  row: number;
  name: string;
  city: string;
  state: string;
  country: string;
  address: string;
  postal: string;
  website: string;
  contactName: string;
  ownerName: string;
  email: string;
  phone: string;
  notes: string;
  category: string;
  raw: Record<string, string>;
};
export type RetailerSheet = {
  name: string;
  rows: string[][];
  headerRow: number;
  mapping: RetailerMapping;
};
export type Retailer = {
  id: string;
  name: string;
  city: string;
  state: string;
  country: string;
  address: string;
  postal: string;
  website: string;
  company_id: string | null;
  prospect_id: string | null;
  client_status: string;
  effective_client_status: string;
  client_evidence: string;
  owner_id: string;
  owner_name: string;
  outreach_status: string;
  next_action: string;
  next_at: string | null;
  tags: string[];
  groups: string[];
  lists: string[];
  version: number;
  people_count: number;
  last_touch: string | null;
  photo_id: string | null;
};
export type RetailerPerson = {
  id: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  notes: string;
  version: number;
};
export type RetailerDetail = {
  retailer: Retailer;
  people: RetailerPerson[];
  events: {
    id: string;
    kind: string;
    body: string;
    occurred_at: string;
    author: string;
  }[];
  photos: { id: string; caption: string; person_id: string | null }[];
  sources: {
    filename: string;
    sheet: string;
    source_row: number;
    group_name: string;
    list_name: string;
    raw: Record<string, string>;
  }[];
  accounts: { id: string; name: string; city: string; lifecycle: string }[];
  history: { id: string; kind: string; body: string; created_at: string }[];
};
