/**
 * Master MSP topic taxonomy (v1) — reusable IP, instantiated per tenant.
 * Templates use [service], [vertical], [location], [framework] slots.
 * The topic graph builder fills them from the tenant's services, verticals
 * and locations, then augments with vertical buyerQuestions, PAA and fan-out.
 */

export const MSP_SERVICES = [
  "managed IT services", "co-managed IT", "IT help desk", "cybersecurity",
  "managed detection and response", "backup and disaster recovery",
  "cloud services", "Microsoft 365", "VoIP phone services", "network management",
  "vCIO services", "compliance services", "IT support",
];

export const FRAMEWORKS: Record<string, string[]> = {
  healthcare: ["HIPAA", "HITECH"],
  dental: ["HIPAA"],
  legal: ["ABA cybersecurity guidelines", "state bar data rules"],
  finance: ["FTC Safeguards Rule", "GLBA", "FINRA", "PCI-DSS"],
  cpa: ["FTC Safeguards Rule", "IRS WISP", "GLBA"],
  manufacturing: ["CMMC", "NIST 800-171", "ITAR"],
  construction: ["OSHA data requirements", "CMMC"],
  nonprofit: ["PCI-DSS"],
  government: ["CJIS", "NIST CSF"],
  default: ["SOC 2", "NIST CSF", "PCI-DSS"],
};

export interface TopicTemplate {
  q: string;
  category: string;
  funnelStage: "awareness" | "consideration" | "decision" | "compliance";
}

export const TEMPLATES: TopicTemplate[] = [
  // Awareness
  { q: "What are the biggest IT risks for [vertical] businesses?", category: "risk", funnelStage: "awareness" },
  { q: "Signs your [vertical] business has outgrown its IT support", category: "growth", funnelStage: "awareness" },
  { q: "How much does downtime cost a [vertical] business?", category: "risk", funnelStage: "awareness" },
  { q: "What cybersecurity threats target [vertical] companies right now?", category: "cybersecurity", funnelStage: "awareness" },
  { q: "Why is ransomware targeting [vertical] businesses?", category: "cybersecurity", funnelStage: "awareness" },
  // Consideration
  { q: "What is [service] and how does it work?", category: "service", funnelStage: "consideration" },
  { q: "How does [service] work for [vertical] businesses?", category: "service", funnelStage: "consideration" },
  { q: "In-house IT vs managed IT services for [vertical]: which is better?", category: "comparison", funnelStage: "consideration" },
  { q: "Co-managed IT vs fully managed IT: what's the difference?", category: "comparison", funnelStage: "consideration" },
  { q: "How much does [service] cost for a small business?", category: "pricing", funnelStage: "consideration" },
  { q: "What should be included in a managed IT services agreement?", category: "contracts", funnelStage: "consideration" },
  { q: "What is an IT SLA and what response times should I expect?", category: "contracts", funnelStage: "consideration" },
  // Decision
  { q: "How to choose an IT provider for a [vertical] business", category: "selection", funnelStage: "decision" },
  { q: "Best managed IT services for [vertical] businesses in [location]", category: "local", funnelStage: "decision" },
  { q: "IT support companies in [location]: how to compare them", category: "local", funnelStage: "decision" },
  { q: "Questions to ask before hiring an MSP", category: "selection", funnelStage: "decision" },
  { q: "What should a [vertical] business budget for IT support?", category: "pricing", funnelStage: "decision" },
  { q: "How to switch IT providers without disruption", category: "onboarding", funnelStage: "decision" },
  // Compliance
  { q: "[framework] IT requirements for [vertical] businesses", category: "compliance", funnelStage: "compliance" },
  { q: "[framework] compliance checklist for [vertical]", category: "compliance", funnelStage: "compliance" },
  { q: "How to pass a [framework] audit: IT preparation guide", category: "compliance", funnelStage: "compliance" },
  { q: "What happens if a [vertical] business fails [framework] compliance?", category: "compliance", funnelStage: "compliance" },
];

export function fillTemplate(t: string, vars: Record<string, string>): string {
  return t.replace(/\[(\w+)\]/g, (_, k) => vars[k] ?? `[${k}]`);
}
