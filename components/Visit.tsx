"use client";

import { useEffect } from "react";
import { track } from "@/lib/track";

const KEY = "one-link-visit";

export function Visit() {
  useEffect(() => {
    try {
      if (sessionStorage.getItem(KEY)) return;
      sessionStorage.setItem(KEY, "1");
    } catch {}
    track("visit");
  }, []);
  return null;
}
