// Agent Card helpers (03-a2a-protocol.md "Agent Card 예시"). OWNER: track A2A core.
// Cards are built per request with the public base URL, so the same code serves localhost and a deploy.
import clinicsSeed from "../../data/seed/clinics.json";
import { getStore } from "../store";
import type { AgentRef, AgentRole } from "./contract";

export const PROTOCOL_VERSION = "1.0";
export const EXT_CLINIC_OPERATION = "https://pibu.app/ext/clinic-operation/v1";
export const EXT_REFERRAL = "https://pibu.app/ext/referral/v1";
export const EXT_CONSENT = "https://pibu.app/ext/consent/v1";
export const EXT_ZK_OFFER_PROOF = "https://pibu.app/ext/zk-offer-proof/v1";
export const DOCUMENTATION_URL = "https://github.com/goranyseoul/jongro3ga/blob/main/docs/spec/03-a2a-protocol.md";

/**
 * Base URL agents use to reach each other and to build card URLs. PUBLIC_BASE_URL wins; otherwise the
 * origin of the incoming request; otherwise localhost on PORT.
 */
export function publicBaseUrl(requestUrl?: string): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  if (requestUrl) {
    try {
      return new URL(requestUrl).origin;
    } catch {
      // fall through
    }
  }
  return `http://localhost:${process.env.PORT || 3000}`;
}

/** Makes a path like "/a2a/clinics/mint/agent-card.json" absolute; absolute URLs (self-hosted clinics) pass through. */
export function absoluteUrl(pathOrUrl: string, baseUrl: string = publicBaseUrl()): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

// ---- clinic slug <-> id ----

interface ClinicKey {
  id: string;
  slug: string;
}

const SEED_CLINICS: ClinicKey[] = (clinicsSeed as Array<{ id: string; slug: string }>).map(({ id, slug }) => ({ id, slug }));

/**
 * The clinic route segment may be a slug ("mint", the URLs in 03) or a clinic id ("cln_mint", what
 * cardUrl() builds from an AgentRef). Both resolve to the clinic id, which is the clinic AgentRef.agentId.
 * Unknown values are returned unchanged so the clinic definition's exists() decides.
 */
export async function resolveClinicId(segment: string): Promise<string> {
  if (segment.startsWith("cln_")) return segment;
  const seeded = SEED_CLINICS.find((c) => c.slug === segment);
  if (seeded) return seeded.id;
  const registry = await getStore().list<ClinicKey>("platform", "clinic_registry");
  return registry.find((c) => c.slug === segment)?.id ?? segment;
}

/** Slug for a clinic id, used to build card URLs in the 03 shape. */
export async function clinicSlug(clinicId: string): Promise<string> {
  const seeded = SEED_CLINICS.find((c) => c.id === clinicId);
  if (seeded) return seeded.slug;
  const registry = await getStore().list<ClinicKey>("platform", "clinic_registry");
  return registry.find((c) => c.id === clinicId)?.slug ?? clinicId;
}

/** Who a card URL points at, for log entries ("to"). */
export async function agentFromUrl(url: string): Promise<AgentRef> {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // relative path
  }
  const clinic = /\/a2a\/clinics\/([^/]+)\//.exec(path);
  if (clinic) return { role: "clinic", agentId: await resolveClinicId(decodeURIComponent(clinic[1])) };
  const customer = /\/a2a\/customers\/([^/]+)\//.exec(path);
  if (customer) return { role: "customer", agentId: decodeURIComponent(customer[1]) };
  return { role: "platform", agentId: "platform" };
}

// ---- card building blocks ----

export const BEARER_SECURITY = {
  securitySchemes: {
    pibuBearer: { httpAuthSecurityScheme: { scheme: "bearer", bearerFormat: "JWT", description: "Agent token issued by PibooK" } },
  },
  securityRequirements: [{ schemes: { pibuBearer: { list: [] } } }],
} as const;

export function rpcUrlFor(role: AgentRole, segment: string, baseUrl: string): string {
  if (role === "platform") return `${baseUrl}/a2a/platform/rpc`;
  if (role === "clinic") return `${baseUrl}/a2a/clinics/${segment}/rpc`;
  return `${baseUrl}/a2a/customers/${segment}/rpc`;
}

export interface CardSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/** An A2A 1.0 card with every required field (03 examples, `node scripts/verify-spec.mjs agentcards`). */
export function buildAgentCard(input: {
  name: string;
  description: string;
  rpcUrl: string;
  organization: string;
  baseUrl: string;
  version?: string;
  extensions?: { uri: string; description: string; required: boolean; params?: Record<string, unknown> }[];
  skills: CardSkill[];
  extendedAgentCard?: boolean;
}): Record<string, unknown> {
  return {
    name: input.name,
    description: input.description,
    supportedInterfaces: [{ url: input.rpcUrl, protocolBinding: "JSONRPC", protocolVersion: PROTOCOL_VERSION }],
    provider: { organization: input.organization, url: input.baseUrl },
    version: input.version ?? "0.1.0",
    documentationUrl: DOCUMENTATION_URL,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: input.extendedAgentCard ?? false,
      ...(input.extensions ? { extensions: input.extensions } : {}),
    },
    ...BEARER_SECURITY,
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills: input.skills,
  };
}

/** The JSON-RPC URL in a card: the JSONRPC / 1.0 interface (09 "A2A 클라이언트"). */
export function jsonRpcUrlFromCard(card: unknown): string | undefined {
  const interfaces = (card as { supportedInterfaces?: unknown })?.supportedInterfaces;
  if (!Array.isArray(interfaces)) return undefined;
  const match = interfaces.find(
    (i: { protocolBinding?: unknown; protocolVersion?: unknown; url?: unknown }) =>
      i?.protocolBinding === "JSONRPC" && String(i?.protocolVersion) === PROTOCOL_VERSION && typeof i?.url === "string",
  ) as { url: string } | undefined;
  return match?.url;
}
