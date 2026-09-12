type AppRoute = "/" | "/workspace" | "/print";

const STATIC_ROUTE_FILES: Record<AppRoute, string> = {
  "/": "index.html",
  "/workspace": "workspace.html",
  "/print": "print.html",
};

type RouteSearch = URLSearchParams | Record<string, string | number | boolean | null | undefined> | string;

export function getAppRouteHref(route: AppRoute, search?: RouteSearch): string {
  const query = normalizeSearch(search);
  if (typeof window !== "undefined" && window.location.protocol === "file:") {
    const url = new URL(STATIC_ROUTE_FILES[route], window.location.href);
    url.search = query;
    return url.toString();
  }

  if (typeof window !== "undefined" && process.env.NODE_ENV === "production") {
    // Sites ではアプリを `/sigma/` 配下に置く。route を origin 相対にすると
    // `/workspace` へ飛んで配信 prefix を失うため、現在の directory から解決する。
    const url = new URL(route === "/" ? "." : route.slice(1), window.location.href);
    url.search = query;
    return url.toString();
  }

  return `${route}${query ? `?${query}` : ""}`;
}

export function navigateToAppRoute(route: AppRoute, search?: RouteSearch): void {
  window.location.href = getAppRouteHref(route, search);
}

function normalizeSearch(search: RouteSearch | undefined): string {
  if (!search) {
    return "";
  }
  if (typeof search === "string") {
    return search.replace(/^\?/, "");
  }
  if (search instanceof URLSearchParams) {
    return search.toString();
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value !== null && value !== undefined) {
      params.set(key, String(value));
    }
  }
  return params.toString();
}
