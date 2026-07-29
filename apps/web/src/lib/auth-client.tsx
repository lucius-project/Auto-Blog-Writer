"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

/**
 * Cross-cutting auth wiring, mounted once in the root layout:
 *  1. patches window.fetch to send the session cookie on every API call
 *  2. redirects to /login when the API answers 401
 * Setup mode (no users yet) keeps the app open and shows nothing.
 */
export default function AuthClient() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const w = window as any;
    if (!w.__abwFetchPatched) {
      w.__abwFetchPatched = true;
      const orig = window.fetch.bind(window);
      window.fetch = ((input: any, init: any = {}) => {
        const url = typeof input === "string" ? input : (input?.url ?? "");
        if (url.startsWith(API)) init = { credentials: "include", ...init };
        return orig(input, init).then((res: Response) => {
          if (res.status === 401 && url.startsWith(API) && !url.includes("/api/auth/") && !location.pathname.startsWith("/login")) {
            location.href = "/login";
          }
          return res;
        });
      }) as typeof fetch;
    }
    setReady(true);
  }, []);
  if (!ready) return null;
  return null;
}
