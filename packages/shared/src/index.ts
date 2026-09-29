import { z } from "zod";

export * from "./qa.js";
export * from "./checklist.js";

// ---------------------------------------------------------------------------
// Queue names — single source of truth for API (producers) and worker
// (consumers). Weekly pipeline order:
//   ingest-site -> research-company -> analyze-gaps -> generate-blog
//     -> publish-blog  (+ weekly-run orchestrator)
// ---------------------------------------------------------------------------

export const QUEUES = {
  ingestSite: "ingest-site",
  researchCompany: "research-company",
  analyzeGaps: "analyze-gaps",
  generateBlog: "generate-blog",
  publishBlog: "publish-blog",
  weeklyRun: "weekly-run",
  extractDocument: "extract-document",
  writeSchedule: "write-schedule",
  offpageDraft: "offpage-draft",
  syncAnalytics: "sync-analytics",
  analyzeCompetitors: "analyze-competitors",
  verifyPublished: "verify-published",
  websiteChecklist: "website-checklist",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// ---------------------------------------------------------------------------
// Job payloads (zod-validated at the API boundary and in workers)
// ---------------------------------------------------------------------------

/** Crawl the tenant site: robots/AI-crawler audit, sitemap discovery, coverage map. */
export const IngestSitePayload = z.object({
  companyId: z.string().min(1),
  /** cap on pages classified this run (cost control) */
  maxPages: z.number().int().min(1).max(500).default(60),
  force: z.boolean().default(false),
});
export type IngestSitePayload = z.infer<typeof IngestSitePayload>;

/** Research the company from its URL: size, services, differentiators, voice. */
export const ResearchCompanyPayload = z.object({
  companyId: z.string().min(1),
  force: z.boolean().default(false),
  /** enqueue analyze-gaps AFTER research completes (correct ordering for "Research new additions") */
  chainAnalyze: z.boolean().default(false),
});
export type ResearchCompanyPayload = z.infer<typeof ResearchCompanyPayload>;

/**
 * Build/refresh the Topic Graph and score it against LIVE visibility data.
 * HARD RULE: ranking/citation evidence must be fetched live at run time.
 */
export const AnalyzeGapsPayload = z.object({
  companyId: z.string().min(1),
  locationId: z.string().optional(),
  verticalId: z.string().optional(),
  /** how many top nodes get live visibility evidence this run (cost control) */
  liveProbeCount: z.number().int().min(0).max(100).default(12),
  /** generate this many NEW buyer questions per (location x vertical) to grow the graph toward full coverage */
  expandPerPair: z.number().int().min(0).max(200).default(0),
});
export type AnalyzeGapsPayload = z.infer<typeof AnalyzeGapsPayload>;

/** Write one article for a topic node, fully SEO+AEO per the content contract. */
export const GenerateBlogPayload = z.object({
  companyId: z.string().min(1),
  topicNodeId: z.string().min(1),
  /** rewrite mode: update THIS existing post in place (same slug), back to review */
  refreshPostId: z.string().optional(),
});
export type GenerateBlogPayload = z.infer<typeof GenerateBlogPayload>;

/** Publish an approved post to the tenant's configured publish target. */
export const PublishBlogPayload = z.object({
  blogPostId: z.string().min(1),
  publishTargetId: z.string().optional(),
});
export type PublishBlogPayload = z.infer<typeof PublishBlogPayload>;

/** One full weekly cycle for a tenant (the forever-loop tick). */
export const WeeklyRunPayload = z.object({
  companyId: z.string().min(1),
});
export type WeeklyRunPayload = z.infer<typeof WeeklyRunPayload>;

/** Draft outreach/post copy for one off-page task. */
export const OffpageDraftPayload = z.object({
  taskId: z.string().min(1),
});
export type OffpageDraftPayload = z.infer<typeof OffpageDraftPayload>;

/** Extract individual testimonials/case examples from an uploaded document. */
export const ExtractDocumentPayload = z.object({
  companyId: z.string().min(1),
  documentId: z.string().min(1),
});
export type ExtractDocumentPayload = z.infer<typeof ExtractDocumentPayload>;

/**
 * Owner-triggered: write N gap articles, then auto-schedule the QA-passing,
 * deduped results across [start, end] during work hours (08:00-17:00 site
 * time), pushing each to the CMS's own scheduler.
 */
export const WriteSchedulePayload = z.object({
  companyId: z.string().min(1),
  count: z.number().int().min(1).max(150),
  start: z.string().datetime(),
  end: z.string().datetime(),
});
export type WriteSchedulePayload = z.infer<typeof WriteSchedulePayload>;

/** Pull a rolling GA4 report (site-wide trend + per-post leaderboard) for a tenant. */
export const SyncAnalyticsPayload = z.object({
  companyId: z.string().min(1),
});
export type SyncAnalyticsPayload = z.infer<typeof SyncAnalyticsPayload>;

/**
 * Crawl the operator's listed competitor domains, map the buyer questions their
 * content answers, and seed the ones missing from the tenant's Topic Graph.
 */
export const AnalyzeCompetitorsPayload = z.object({
  companyId: z.string().min(1),
  /** omit = every competitor for the company */
  competitorId: z.string().optional(),
  maxPagesPerCompetitor: z.number().int().min(1).max(200).default(50),
});
export type AnalyzeCompetitorsPayload = z.infer<typeof AnalyzeCompetitorsPayload>;

/**
 * Sweep scheduled posts whose go-live time has passed: swap the CMS's
 * placeholder URL for the real permalink, fix the canonical, verify it's live.
 */
export const VerifyPublishedPayload = z.object({
  /** omit = every company */
  companyId: z.string().optional(),
});
export type VerifyPublishedPayload = z.infer<typeof VerifyPublishedPayload>;

/** Run the live website SEO/AEO checklist for a tenant's own site. */
export const WebsiteChecklistPayload = z.object({
  companyId: z.string().min(1),
});
export type WebsiteChecklistPayload = z.infer<typeof WebsiteChecklistPayload>;

export const JOB_PAYLOADS = {
  [QUEUES.ingestSite]: IngestSitePayload,
  [QUEUES.researchCompany]: ResearchCompanyPayload,
  [QUEUES.analyzeGaps]: AnalyzeGapsPayload,
  [QUEUES.generateBlog]: GenerateBlogPayload,
  [QUEUES.publishBlog]: PublishBlogPayload,
  [QUEUES.weeklyRun]: WeeklyRunPayload,
  [QUEUES.extractDocument]: ExtractDocumentPayload,
  [QUEUES.writeSchedule]: WriteSchedulePayload,
  [QUEUES.offpageDraft]: OffpageDraftPayload,
  [QUEUES.syncAnalytics]: SyncAnalyticsPayload,
  [QUEUES.analyzeCompetitors]: AnalyzeCompetitorsPayload,
  [QUEUES.verifyPublished]: VerifyPublishedPayload,
  [QUEUES.websiteChecklist]: WebsiteChecklistPayload,
} as const;

// ---------------------------------------------------------------------------
// Shared API input schemas
// ---------------------------------------------------------------------------

export const CreateCompanyInput = z.object({
  name: z.string().min(1),
  url: z.string().url(),
});
export type CreateCompanyInput = z.infer<typeof CreateCompanyInput>;

export const CreateLocationInput = z.object({
  name: z.string().min(1),
  city: z.string().min(1),
  state: z.string().optional(),
  country: z.string().default("US"),
});
export type CreateLocationInput = z.infer<typeof CreateLocationInput>;

export const CreateVerticalInput = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "kebab-case slug required"),
});
export type CreateVerticalInput = z.infer<typeof CreateVerticalInput>;

// Default per-tenant guardrails (overridable via Company.settings)
export const DEFAULT_SETTINGS = {
  /** max net-new articles per (location x vertical) per weekly run */
  weeklyCapPerPair: 5,
  /** max net-new articles per company per weekly run */
  weeklyCapTotal: 10,
  killSwitch: false,
  autoApprove: false,
} as const;
export type TenantSettings = typeof DEFAULT_SETTINGS;
