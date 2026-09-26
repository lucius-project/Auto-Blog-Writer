export interface PublishArticle {
  title: string;
  slug: string;
  bodyHtml: string;
  metaTitle: string;
  metaDescription: string;
  jsonLd: unknown;
  /** ISO datetime to schedule; null = publish immediately */
  scheduledFor: string | null;
  category?: string;
  /** cartoon/preview image to attach (PNG on disk) */
  previewImage?: { filePath: string; alt: string; width: number; height: number } | null;
}

export interface PublishResult {
  ok: boolean;
  liveUrl?: string;
  externalId?: string;
  detail?: string;
}

export interface Publisher {
  kind: string;
  publish(article: PublishArticle): Promise<PublishResult>;
  /** Update an existing CMS page in place (rewrites). Optional per adapter. */
  update?(externalId: string, article: PublishArticle): Promise<PublishResult>;
  /** Fetch a pushed post's current state; once live, returns its real URL (and fixes its canonical). */
  /** Attach an image as the post's featured image without touching its content. */
  setFeaturedImage?(externalId: string, article: Pick<PublishArticle, "slug" | "previewImage">): Promise<PublishResult & { mediaId?: number }>;
  resolveLive?(externalId: string, article: PublishArticle): Promise<PublishResult & { live: boolean }>;
}
