export type IntakePayload = {
  submissionId: string;
  form: string;
  name: string;
  email: string;
  company: string;
  phone: string;
  message: string;
  pageUrl: string;
  fields: Record<string, string>;
  tracking: Record<string, string>;
};
export function normalizeIntake(
  data: Record<string, unknown>,
  options: { brand: string; form: string; page?: string },
): IntakePayload;
export function deliverIntake(
  env: Record<string, string | undefined>,
  brand: string,
  payload: IntakePayload,
  send?: (url: string, options: RequestInit) => Promise<Response>,
): Promise<{ enabled: boolean }>;
export function withSalesForce<
  T extends (request: Request) => Promise<Response>,
>(
  handler: T,
  options: {
    brand: string;
    form: string;
    page?: string;
    getEnv: () => Promise<Record<string, string | undefined>>;
  },
): (request: Request) => Promise<Response>;
