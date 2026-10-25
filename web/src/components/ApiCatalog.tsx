import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchApis, type PublicApi } from "../api/apis.js";
import { ErrorBanner } from "./ErrorBanner.js";

export const CATALOG_PAGE_SIZE = 20;

interface Props {
  onTry: (api: PublicApi) => void;
  onView?: (api: PublicApi) => void;
  onCopy: (text: string) => void;
}

/** Append a page, skipping APIs already shown (offset paging can shift when APIs are added). */
function mergePage(current: PublicApi[], page: PublicApi[]): PublicApi[] {
  const seen = new Set(current.map((api) => api.id));
  return [...current, ...page.filter((api) => !seen.has(api.id))];
}

/**
 * Parse a raw tag input string into a deduplicated, normalised array of tags.
 * Tags are comma-separated, trimmed and lowercased (matching server schema).
 */
function parseTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function ApiCatalog({ onTry, onView, onCopy }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const [debouncedTags, setDebouncedTags] = useState<string[]>([]);
  const [items, setItems] = useState<PublicApi[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"loading" | "idle" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // The search the shown items belong to, and where its next page starts.
  // Kept in a ref so "Load more" always pages the same query as the list on
  // screen, even while the user is typing a new one.
  const pagingRef = useRef({ query: "", tags: [] as string[], nextOffset: 0 });
  // Aborts whichever request is in flight when the search changes.
  const abortRef = useRef<AbortController | null>(null);

  // Debounce text query
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  // Debounce tag input
  useEffect(() => {
    const id = setTimeout(() => setDebouncedTags(parseTags(tagInput)), 250);
    return () => clearTimeout(id);
  }, [tagInput]);

  // First page for each search / tag change.
  useEffect(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    pagingRef.current = { query: debounced, tags: debouncedTags, nextOffset: 0 };
    setItems([]);
    setHasMore(false);
    setStatus("loading");
    setError(null);
    setMoreError(null);
    setLoadingMore(false);

    // One extra row tells us whether another page exists, so there is no
    // "Load more" button that leads to an empty page.
    fetchApis(debounced, ctrl.signal, CATALOG_PAGE_SIZE + 1, 0, debouncedTags)
      .then((page) => {
        if (ctrl.signal.aborted) return;
        setItems(mergePage([], page.slice(0, CATALOG_PAGE_SIZE)));
        setHasMore(page.length > CATALOG_PAGE_SIZE);
        pagingRef.current.nextOffset = CATALOG_PAGE_SIZE;
        setStatus("idle");
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load APIs");
        setStatus("error");
      });

    return () => ctrl.abort();
  }, [debounced, debouncedTags, reloadKey]);

  async function loadMore() {
    if (loadingMore) return;
    const ctrl = abortRef.current;
    const { query: pageQuery, tags: pageTags, nextOffset } = pagingRef.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchApis(
        pageQuery,
        ctrl?.signal,
        CATALOG_PAGE_SIZE + 1,
        nextOffset,
        pageTags,
      );
      // The search changed while this page was loading: drop it.
      if (ctrl?.signal.aborted || pagingRef.current.query !== pageQuery) return;
      setItems((prev) => mergePage(prev, page.slice(0, CATALOG_PAGE_SIZE)));
      setHasMore(page.length > CATALOG_PAGE_SIZE);
      pagingRef.current.nextOffset = nextOffset + CATALOG_PAGE_SIZE;
    } catch (err) {
      if (ctrl?.signal.aborted) return;
      setMoreError(err instanceof Error ? err.message : "Failed to load more APIs");
    } finally {
      if (!ctrl?.signal.aborted) setLoadingMore(false);
    }
  }

  const loaded = status === "idle";
  const activeTags = debouncedTags;

  return (
    <section aria-labelledby="catalog-heading">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <h2 id="catalog-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t("catalog.heading")}
        </h2>
        <div className="flex flex-col gap-2 sm:w-72">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("catalog.search_placeholder")}
            aria-label={t("catalog.search_label")}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          />
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            placeholder={t("catalog.tag_filter_placeholder", {
              defaultValue: "Filter by tags (e.g. ai, nlp)",
            })}
            aria-label={t("catalog.tag_filter_label", {
              defaultValue: "Filter by tags (comma-separated; all must match)",
            })}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          />
          {activeTags.length > 0 && (
            <div className="flex flex-wrap gap-1" aria-label="Active tag filters">
              {activeTags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                >
                  #{tag}
                  <button
                    aria-label={`Remove tag filter: ${tag}`}
                    onClick={() =>
                      setTagInput((prev) =>
                        parseTags(prev)
                          .filter((t) => t !== tag)
                          .join(", "),
                      )
                    }
                    className="ml-0.5 text-indigo-500 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-100"
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                onClick={() => setTagInput("")}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                aria-label="Clear all tag filters"
              >
                {t("catalog.clear_tags", { defaultValue: "Clear all" })}
              </button>
            </div>
          )}
        </div>
      </div>

      {status === "error" && (
        <ErrorBanner
          message={error ?? "Failed to load APIs"}
          onRetry={() => setReloadKey((key) => key + 1)}
        />
      )}

      {status === "loading" && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-800" />
          ))}
        </div>
      )}

      {loaded && items.length === 0 && (
        <p className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {activeTags.length > 0
            ? t("catalog.empty_no_match_tags", {
                defaultValue: `No APIs matched tags: ${activeTags.map((t) => `#${t}`).join(", ")}`,
                tags: activeTags.map((t) => `#${t}`).join(", "),
              })
            : debounced
              ? t("catalog.empty_no_match", { query: debounced })
              : t("catalog.empty_no_apis")}
        </p>
      )}

      {loaded && items.length > 0 && (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((api) => (
              <li
                key={api.id}
                className="flex flex-col rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
              >
                <div className="mb-1 flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-gray-900 dark:text-gray-100">{api.name}</h3>
                  <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-sm font-semibold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                    {api.price} USDC
                    <span className="font-normal text-indigo-500 dark:text-indigo-400">
                      {" "}
                      {t("catalog.per_call")}
                    </span>
                  </span>
                </div>
                {api.description && (
                  <p className="mb-3 line-clamp-3 text-sm text-gray-600 dark:text-gray-300">
                    {api.description}
                  </p>
                )}
                <div className="mb-3 flex flex-wrap gap-1">
                  {api.allowedMethods.map((m) => (
                    <span
                      key={m}
                      className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-200"
                    >
                      {m}
                    </span>
                  ))}
                  {api.tags.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => {
                        // Clicking a tag adds it to the active filter.
                        setTagInput((prev) => {
                          const current = parseTags(prev);
                          if (current.includes(tag)) return prev;
                          return [...current, tag].join(", ");
                        });
                      }}
                      aria-label={`Filter by tag: ${tag}`}
                      title={`Filter by #${tag}`}
                      className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/60"
                    >
                      #{tag}
                    </button>
                  ))}
                </div>
                <div className="mt-auto flex gap-2">
                  <button
                    onClick={() => onTry(api)}
                    className="flex-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
                  >
                    {t("catalog.try_it")}
                  </button>
                  {onView && (
                    <button
                      onClick={() => onView(api)}
                      aria-label={`Details for ${api.name}`}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      Details
                    </button>
                  )}
                  <button
                    onClick={() => onCopy(api.proxyUrl)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    {t("catalog.copy_url")}
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-6 flex flex-col items-center gap-2">
            <p aria-live="polite" className="text-xs text-gray-500 dark:text-gray-400">
              {hasMore
                ? `Showing ${items.length} APIs`
                : `Showing all ${items.length} ${items.length === 1 ? "API" : "APIs"}`}
            </p>
            {moreError && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {moreError}
              </p>
            )}
            {hasMore && (
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="rounded-lg border border-gray-300 px-5 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                {loadingMore ? "Loading…" : moreError ? "Retry" : "Load more"}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
