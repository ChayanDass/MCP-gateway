import { useEffect, useState } from "react";

// Hash routing: each page has a real URL (for example #/members/3f2a…), so refresh,
// back and bookmarks work without any server-side route configuration.
export function currentPath(): string[] {
  const raw = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return raw.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
}

// Query parameters after the hash path, e.g. #/servers?oauth=connected.
export function currentQuery(): URLSearchParams {
  const i = window.location.hash.indexOf("?");
  return new URLSearchParams(i >= 0 ? window.location.hash.slice(i + 1) : "");
}

export function navigate(path: string): void {
  window.location.hash = `/${path.replace(/^\/+/, "")}`;
}

export function useRoute(): string[] {
  const [route, setRoute] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setRoute(currentPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
